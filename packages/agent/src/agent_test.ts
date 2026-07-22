import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { Effect, Stream } from "effect";
import type { RecordedEvent } from "@niuma/schema";
import type {
  ChatRequest,
  ModelRef,
  ProviderAdapter,
  StreamEvent as ProviderStreamEvent,
} from "@niuma/provider";
import {
  eventsToMessages,
} from "./context.ts";
import { buildSummary, compactMessages } from "./compaction.ts";
import { makeApprovalGateway } from "./approval.ts";
import {
  SessionManager,
  type AgentInfra,
} from "./session.ts";
import type {
  EventInput,
  EventLog,
  ToolPipeline,
} from "./deps.ts";

// In-memory event log honouring the EventLog port.
function makeMemoryLog(): EventLog & { dump: (id: string) => RecordedEvent[] } {
  const logs = new Map<string, RecordedEvent[]>();
  let seq = 0;
  return {
    append: (sessionId, input: EventInput) =>
      Effect.sync(() => {
        const arr = logs.get(sessionId) ?? [];
        const ev = {
          seq: seq++,
          ts: Date.now(),
          sessionId,
          ...input,
        } as RecordedEvent;
        arr.push(ev);
        logs.set(sessionId, arr);
        return ev;
      }),
    replay: (sessionId) =>
      Effect.sync(() => [...(logs.get(sessionId) ?? [])]),
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

const noTools: ToolPipeline = {
  defs: () => [],
  run: (batch) =>
    Effect.succeed(
      batch.map((c) => ({
        callId: c.callId,
        content: `ran ${c.name}`,
        isError: false,
        durationMs: 1,
      })),
    ),
};

Deno.test("runTurn: plain answer, no tools", async () => {
  const log = makeMemoryLog();
  const infra: AgentInfra = {
    eventLog: log,
    provider: scriptedProvider([[
      { _tag: "TextDelta", text: "hello " },
      { _tag: "TextDelta", text: "world" },
      { _tag: "Finish", reason: "stop", usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } },
    ]]),
    tools: noTools,
    approvals: makeApprovalGateway(log),
    defaultModel: "test-model",
  };
  const mgr = new SessionManager(infra);
  const session = await Effect.runPromise(
    mgr.createAndRecord({ workspace: "/tmp/ws" }),
  );
  const result = await Effect.runPromise(
    session.prompt([{ type: "text", text: "hi" }]),
  );
  assertEquals(result.text, "hello world");
  assertEquals(result.stopReason, "stop");
  const types = log.dump(session.id).map((e) => e.type);
  assertEquals(types.includes("turn.started"), true);
  assertEquals(types.includes("assistant.message"), true);
  assertEquals(types.includes("turn.completed"), true);
});

Deno.test("runTurn: one tool round-trip then answer", async () => {
  const log = makeMemoryLog();
  const infra: AgentInfra = {
    eventLog: log,
    provider: scriptedProvider([
      [
        { _tag: "ToolCall", id: "c1", name: "read", arguments: '{"path":"a.ts"}' },
        { _tag: "Finish", reason: "tool_calls", usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 } },
      ],
      [
        { _tag: "TextDelta", text: "done" },
        { _tag: "Finish", reason: "stop", usage: { promptTokens: 6, completionTokens: 1, totalTokens: 7 } },
      ],
    ]),
    tools: noTools,
    approvals: makeApprovalGateway(log),
    defaultModel: "test-model",
  };
  const mgr = new SessionManager(infra);
  const session = await Effect.runPromise(
    mgr.createAndRecord({ workspace: "/tmp/ws" }),
  );
  const result = await Effect.runPromise(
    session.prompt([{ type: "text", text: "read a.ts" }]),
  );
  assertEquals(result.text, "done");
  const types = log.dump(session.id).map((e) => e.type);
  assertEquals(types.filter((t) => t === "tool.call.requested").length, 1);
  assertEquals(types.filter((t) => t === "tool.result").length, 1);
});

Deno.test("length stop with tool calls yields synthetic error result", async () => {
  const log = makeMemoryLog();
  const infra: AgentInfra = {
    eventLog: log,
    provider: scriptedProvider([
      [
        { _tag: "ToolCall", id: "c1", name: "bash", arguments: '{"command":"ls"}' },
        { _tag: "Finish", reason: "length" },
      ],
      [
        { _tag: "TextDelta", text: "recovered" },
        { _tag: "Finish", reason: "stop" },
      ],
    ]),
    tools: noTools,
    approvals: makeApprovalGateway(log),
    defaultModel: "test-model",
  };
  const mgr = new SessionManager(infra);
  const session = await Effect.runPromise(
    mgr.createAndRecord({ workspace: "/tmp/ws" }),
  );
  const result = await Effect.runPromise(
    session.prompt([{ type: "text", text: "run ls" }]),
  );
  assertEquals(result.text, "recovered");
  const results = log.dump(session.id).filter((e) => e.type === "tool.result");
  assertEquals(results.length, 1);
  assertEquals(
    results[0].type === "tool.result" && results[0].data.isError,
    true,
  );
});

Deno.test("context helpers: replay, compaction, summary", () => {
  const base = { seq: 0, ts: 0, sessionId: "s" };
  const events: RecordedEvent[] = [
    { ...base, type: "user.message", data: { parts: [{ type: "text", text: "u1" }] } },
    {
      ...base,
      type: "assistant.message",
      data: {
        parts: [{ type: "tool_call", id: "t1", name: "write", input: { path: "x.ts" } }],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    },
    {
      ...base,
      type: "tool.call.requested",
      data: { callId: "t1", name: "write", input: { path: "x.ts" } },
    },
    { ...base, type: "tool.result", data: { callId: "t1", content: "ok", isError: false, durationMs: 1 } },
    { ...base, type: "user.message", data: { parts: [{ type: "text", text: "u2" }] } },
    { ...base, type: "user.message", data: { parts: [{ type: "text", text: "u3" }] } },
  ];
  const messages = eventsToMessages(events);
  assertEquals(messages.length, 5);
  assertEquals(messages[0].role, "user");
  assertEquals(messages[2].role, "tool");

  const summary = buildSummary(events);
  assertEquals(summary.includes("x.ts"), true);

  const compacted = compactMessages(messages, summary, 2);
  // summary + last 2 user turns (u2, u3)
  assertEquals(compacted[0].role, "user");
  assertEquals(compacted[0].content.includes("summary"), true);
  assertEquals(compacted[compacted.length - 1].content, "u3");
});
