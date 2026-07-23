import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { Effect, Stream } from "effect";
import type { RecordedEvent } from "@niuma/schema";
import type {
  ChatRequest,
  ModelRef,
  ProviderAdapter,
  StreamEvent as ProviderStreamEvent,
} from "@niuma/provider";
import type { PermissionEngine as ToolsPermissionEngine } from "@niuma/tools";
import { makeApprovalGateway } from "../src/approval.ts";
import { makeToolPipeline } from "../src/tool_pipeline.ts";
import {
  AgentSession,
  SessionManager,
  type AgentInfra,
} from "../src/session.ts";
import type { EventInput, EventLog, ToolMode } from "../src/deps.ts";

// Permissive stub engine for tests: every call resolves to Allow so the
// pipeline never escalates to ctx.ask. The real @niuma/permission chain
// (with its manual-mode default Ask) is exercised in the server package.
const allowAllEngine = (): ToolsPermissionEngine => ({
  evaluate: async () => ({ decision: "allow" }),
  remember: async () => {},
  patternFor: () => "",
});

// In-memory event log honouring the EventLog port.
function makeMemoryLog(): EventLog & { dump: (id: string) => RecordedEvent[] } {
  const logs = new Map<string, RecordedEvent[]>();
  let seq = 0;
  return {
    append: (sessionId, input: EventInput) =>
      Effect.sync(() => {
        const arr = logs.get(sessionId) ?? [];
        const ev = { seq: seq++, ts: Date.now(), sessionId, ...input } as RecordedEvent;
        arr.push(ev);
        logs.set(sessionId, arr);
        return ev;
      }),
    replay: (sessionId) => Effect.sync(() => [...(logs.get(sessionId) ?? [])]),
    dump: (id) => [...(logs.get(id) ?? [])],
  };
}

// Provider that emits a scripted list of stream events per call.
function scriptedProvider(
  scripts: ProviderStreamEvent[][],
): ProviderAdapter {
  let i = 0;
  return {
    listModels: () => Effect.succeed([] as ReadonlyArray<ModelRef>),
    stream: (_req: ChatRequest) => {
      const script = scripts[Math.min(i, scripts.length - 1)];
      i++;
      return Stream.fromArray(script);
    },
  };
}

// Build an AgentInfra wired with the real @niuma/tools pipeline adapter so
// tests exercise the same read-only filtering + runPipeline plumbing the
// server uses. `sessions` is populated as AgentSessions are created so the
// spawn_subagent tool can dispatch back to AgentSession.spawnSubagent.
function makeInfra(
  log: EventLog,
  scripts: ProviderStreamEvent[][],
  sessions: Map<string, { spawnSubagent: (prompt: string, mode: ToolMode) => Effect.Effect<string> }>,
): AgentInfra {
  const tools = makeToolPipeline({
    engine: allowAllEngine(),
    spawnSubagent: async (req) => {
      const parent = sessions.get(req.parentSessionId);
      if (!parent) {
        return {
          sessionId: req.parentSessionId,
          text: "error: parent session not found",
        };
      }
      const mode = req.mode === "read-only" ? "read-only" : "full";
      try {
        const text = await Effect.runPromise(parent.spawnSubagent(req.prompt, mode));
        return { sessionId: req.parentSessionId, text };
      } catch (e) {
        return {
          sessionId: req.parentSessionId,
          text: `error: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    },
  });
  return {
    eventLog: log,
    provider: scriptedProvider(scripts),
    tools,
    approvals: makeApprovalGateway(log),
    defaultModel: "test-model",
  };
}

Deno.test("AgentSession: spawnSubagent returns child's final text", async () => {
  const log = makeMemoryLog();
  const sessions = new Map<string, { spawnSubagent: (prompt: string, mode: ToolMode) => Effect.Effect<string> }>();
  // Parent: spawn a read-only subagent. Child: reply "child reply".
  const infra = makeInfra(
    log,
    [
      [
        {
          _tag: "ToolCall",
          id: "call_x",
          name: "spawn_subagent",
          arguments: '{"prompt":"summarise","mode":"read-only"}',
        },
        { _tag: "Finish", reason: "tool_calls", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
      ],
      // The child runs after parent's first sample, so it consumes the next script.
      [
        { _tag: "TextDelta", text: "child reply" },
        { _tag: "Finish", reason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
      ],
      // Parent's final sample after its subagent returns.
      [
        { _tag: "TextDelta", text: "parent done" },
        { _tag: "Finish", reason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
      ],
    ],
    sessions,
  );
  const mgr = new SessionManager(infra);
  const parent = await Effect.runPromise(
    mgr.createAndRecord({ workspace: "/tmp/ws" }),
  );
  sessions.set(parent.id, parent);
  const result = await Effect.runPromise(
    parent.prompt([{ type: "text", text: "dispatch a subagent" }]),
  );
  assertEquals(result.text, "parent done");
  // subagent.spawned was recorded on the parent session log
  const types = log.dump(parent.id).map((e) => e.type);
  assertEquals(types.includes("subagent.spawned"), true);
  // The child session also got a session.created event
  const spawned = log.dump(parent.id).find((e) => e.type === "subagent.spawned");
  assertEquals(spawned?.type, "subagent.spawned");
  if (spawned?.type === "subagent.spawned") {
    const childEvents = log.dump(spawned.data.childSessionId).map((e) => e.type);
    assertEquals(childEvents.includes("session.created"), true);
    assertEquals(childEvents.includes("assistant.message"), true);
  }
});

Deno.test("AgentSession: spawnSubagent refuses past depth 1", async () => {
  const log = makeMemoryLog();
  const sessions = new Map<string, { spawnSubagent: (prompt: string, mode: ToolMode) => Effect.Effect<string> }>();
  // Parent at depth 0 tries to spawn; child at depth 1 attempts to spawn
  // again — the agent refuses before sampling the grandchild's tool call,
  // feeding back a synthetic error result so the child produces final text.
  const infra = makeInfra(
    log,
    [
      [
        {
          _tag: "ToolCall",
          id: "p1",
          name: "spawn_subagent",
          arguments: '{"prompt":"nested"}',
        },
        { _tag: "Finish", reason: "tool_calls", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
      ],
      // Child's first sample: it tries to spawn again. The pipeline refuses
      // (depth limit) and feeds back an error result; the child samples again.
      [
        {
          _tag: "ToolCall",
          id: "c1",
          name: "spawn_subagent",
          arguments: '{"prompt":"too deep"}',
        },
        { _tag: "Finish", reason: "tool_calls", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
      ],
      // Child's second sample: produces final text after refusal.
      [
        { _tag: "TextDelta", text: "child gave up" },
        { _tag: "Finish", reason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
      ],
      // Parent's final sample after its subagent returns.
      [
        { _tag: "TextDelta", text: "parent done" },
        { _tag: "Finish", reason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
      ],
    ],
    sessions,
  );
  const mgr = new SessionManager(infra);
  const parent = await Effect.runPromise(
    mgr.createAndRecord({ workspace: "/tmp/ws" }),
  );
  sessions.set(parent.id, parent);
  const result = await Effect.runPromise(
    parent.prompt([{ type: "text", text: "nest" }]),
  );
  assertEquals(result.text, "parent done");
  // Only one subagent.spawned event (the parent's); the grandchild was refused.
  const spawnedCount = log.dump(parent.id).filter((e) =>
    e.type === "subagent.spawned"
  ).length;
  assertEquals(spawnedCount, 1);
});

Deno.test("AgentSession: read-only mode drops mutating tool defs", () => {
  const log = makeMemoryLog();
  const sessions = new Map<string, { spawnSubagent: (prompt: string, mode: ToolMode) => Effect.Effect<string> }>();
  const infra = makeInfra(log, [], sessions);
  const mgr = new SessionManager(infra);
  const child = mgr.create({
    workspace: "/tmp/ws",
    mode: "read-only",
    depth: 1,
  });
  const roDefs = infra.tools.defs(child.mode).map((d) => d.name);
  assertEquals(roDefs.includes("bash"), false);
  assertEquals(roDefs.includes("write"), false);
  assertEquals(roDefs.includes("edit"), false);
  assertEquals(roDefs.includes("apply_patch"), false);
  assertEquals(roDefs.includes("read"), true);
  // Mutating tools are present in full mode.
  const fullDefs = infra.tools.defs("full").map((d) => d.name);
  assertEquals(fullDefs.includes("bash"), true);
  // Silence unused-var warning for AgentSession construction side effect.
  void AgentSession;
});

Deno.test("ApprovalGateway: resolve unblocks parked ask", async () => {
  const log = makeMemoryLog();
  const gateway = makeApprovalGateway(log);
  const askPromise = Effect.runPromise(
    gateway.ask("s1", { callId: "c1", name: "bash", input: { command: "ls" } }),
  );
  // Give the parked callback a tick to register.
  await new Promise((r) => setTimeout(r, 5));
  gateway.resolve("pending-wrong-id", "once"); // unknown id: no-op
  assertEquals(gateway.pending.size, 1);
  const [pendingId] = gateway.pending.keys();
  gateway.resolve(pendingId!, "always", "looks safe");
  const outcome = await askPromise;
  assertEquals(outcome.decision, "always");
  assertEquals(outcome.feedback, "looks safe");
  assertEquals(gateway.pending.size, 0);
});

Deno.test("ApprovalGateway: abort signal releases parked ask with reject", async () => {
  const log = makeMemoryLog();
  const gateway = makeApprovalGateway(log);
  const ac = new AbortController();
  const askPromise = Effect.runPromise(
    gateway.ask(
      "s1",
      { callId: "c1", name: "bash", input: { command: "ls" } },
      ac.signal,
    ),
  );
  // Give the parked callback a tick to register its abort listener.
  await new Promise((r) => setTimeout(r, 5));
  assertEquals(gateway.pending.size, 1);
  ac.abort();
  const outcome = await askPromise;
  assertEquals(outcome.decision, "reject");
  assertEquals(outcome.feedback, "aborted");
  // The parked entry must have been cleaned up, not leaked.
  assertEquals(gateway.pending.size, 0);
  // A late external resolve after abort is a no-op.
  gateway.resolve([...gateway.pending.keys()][0] ?? "any", "always");
});
