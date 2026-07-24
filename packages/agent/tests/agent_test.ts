import { assertEquals } from "@std/assert";
import { Effect, Stream } from "effect";
import type { LiveEvent, RecordedEvent } from "@niuma/schema";
import type {
  ChatRequest,
  Message as ProviderMessage,
  ModelRef,
  ProviderAdapter,
  ProviderError,
  StreamEvent as ProviderStreamEvent,
} from "@niuma/provider";
import {
  AuthFailed,
  ContextOverflow,
  Network,
  RateLimited,
} from "@niuma/provider";
import { eventsToMessages, projectEvent } from "../src/context.ts";
import {
  buildSummary,
  compactMessages,
  isSummaryMessage,
  SUMMARIZATION_PROMPT,
  summarizeHistory,
  SUMMARY_PREFIX,
} from "../src/compaction.ts";
import { makeApprovalGateway } from "../src/approval.ts";
import { type AgentInfra, SessionManager } from "../src/session.ts";
import type { EventInput, EventLog, ToolPipeline } from "../src/deps.ts";

// In-memory event log honouring the EventLog port.
function makeMemoryLog(): EventLog & {
  dump: (id: string) => RecordedEvent[];
  replayCalls: () => number;
} {
  const logs = new Map<string, RecordedEvent[]>();
  let seq = 0;
  let replays = 0;
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
      Effect.sync(() => {
        replays++;
        return [...(logs.get(sessionId) ?? [])];
      }),
    dump: (id) => [...(logs.get(id) ?? [])],
    replayCalls: () => replays,
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

// Provider whose streams fail (or emit partial text then fail) per script step.
// `fail` present = emit `events` then fail with that error; absent = succeed
// with `events`. Captures every request (snapshotting the message list, since
// Fix D's incremental mirror mutates the same `messages` array after sampling)
// so tests can assert call count and message-list shape across retries and
// ContextOverflow force-compaction.
function flakyProvider(
  steps: Array<{ events: ProviderStreamEvent[]; fail?: ProviderError }>,
): ProviderAdapter & {
  calls: () => number;
  requests: () => ChatRequest[];
} {
  let i = 0;
  const reqs: ChatRequest[] = [];
  return {
    calls: () => i,
    requests: () => reqs,
    listModels: () => Effect.succeed([] as ReadonlyArray<ModelRef>),
    stream: (req: ChatRequest) => {
      // Snapshot messages at capture time: the agent loop maintains a single
      // mutable `messages` array and keeps mirroring appends into it after the
      // sample returns, so a live reference would reflect post-sample state.
      reqs.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
      const step = steps[Math.min(i, steps.length - 1)];
      i++;
      return step.fail
        ? Stream.concat(Stream.fromArray(step.events), Stream.fail(step.fail))
        : Stream.fromArray(step.events);
    },
  };
}

// Recorded-event type guards so filtered arrays keep their `data` narrowing.
type ErrorOccurredEvent = Extract<RecordedEvent, { type: "error.occurred" }>;
const isErrorOccurred = (e: RecordedEvent): e is ErrorOccurredEvent =>
  e.type === "error.occurred";
type TurnCompletedEvent = Extract<RecordedEvent, { type: "turn.completed" }>;
const isTurnCompleted = (e: RecordedEvent): e is TurnCompletedEvent =>
  e.type === "turn.completed";
type AssistantMessageEvent = Extract<
  RecordedEvent,
  { type: "assistant.message" }
>;
const isAssistantMessage = (e: RecordedEvent): e is AssistantMessageEvent =>
  e.type === "assistant.message";

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
    event_log: log,
    provider: scriptedProvider([[
      { _tag: "TextDelta", text: "hello " },
      { _tag: "TextDelta", text: "world" },
      {
        _tag: "Finish",
        reason: "stop",
        usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
      },
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

Deno.test("runTurn: streams and persists thinking before text", async () => {
  const log = makeMemoryLog();
  const infra: AgentInfra = {
    eventLog: log,
    provider: scriptedProvider([[
      { _tag: "ThinkingDelta", text: "reason " },
      { _tag: "ThinkingDelta", text: "carefully" },
      { _tag: "TextDelta", text: "answer" },
      { _tag: "Finish", reason: "stop" },
    ]]),
    tools: noTools,
    approvals: makeApprovalGateway(log),
    defaultModel: "test-model",
  };
  const mgr = new SessionManager(infra);
  const session = await Effect.runPromise(
    mgr.createAndRecord({ workspace: "/tmp/ws" }),
  );
  await Effect.runPromise(
    session.prompt([{ type: "text", text: "hi" }]),
  );

  const assistant = log.dump(session.id).find(isAssistantMessage);
  assertEquals(assistant?.data.parts, [
    { type: "thinking", text: "reason carefully" },
    { type: "text", text: "answer" },
  ]);
});

Deno.test("runTurn: encrypted thinking closes its block", async () => {
  const log = makeMemoryLog();
  const infra: AgentInfra = {
    eventLog: log,
    provider: scriptedProvider([[
      { _tag: "ThinkingDelta", text: "first", encrypted: "first-opaque" },
      { _tag: "TextDelta", text: "answer" },
      { _tag: "ThinkingDelta", text: "second", encrypted: "opaque" },
      { _tag: "Finish", reason: "stop" },
    ]]),
    tools: noTools,
    approvals: makeApprovalGateway(log),
    defaultModel: "test-model",
  };
  const mgr = new SessionManager(infra);
  const session = await Effect.runPromise(
    mgr.createAndRecord({ workspace: "/tmp/ws" }),
  );
  await Effect.runPromise(
    session.prompt([{ type: "text", text: "hi" }]),
  );

  const assistant = log.dump(session.id).find(isAssistantMessage);
  assertEquals(assistant?.data.parts, [
    { type: "thinking", text: "first", encrypted: "first-opaque" },
    { type: "thinking", text: "second", encrypted: "opaque" },
    { type: "text", text: "answer" },
  ]);
});

Deno.test("runTurn: passes default thinking config to provider", async () => {
  const log = makeMemoryLog();
  const provider = flakyProvider([{
    events: [{ _tag: "Finish", reason: "stop" }],
  }]);
  const infra: AgentInfra = {
    eventLog: log,
    provider,
    tools: noTools,
    approvals: makeApprovalGateway(log),
    defaultModel: "test-model",
    defaultThinking: { effort: "high", keep: "none" },
  };
  const mgr = new SessionManager(infra);
  const session = await Effect.runPromise(
    mgr.createAndRecord({ workspace: "/tmp/ws" }),
  );
  await Effect.runPromise(
    session.prompt([{ type: "text", text: "hi" }]),
  );

  assertEquals(provider.requests()[0].thinking, {
    effort: "high",
    keep: "none",
  });
});

Deno.test("eventsToMessages projects thinking unless keep is none", () => {
  const base = { seq: 0, ts: 0, sessionId: "s" };
  const events: RecordedEvent[] = [{
    ...base,
    type: "assistant.message",
    data: {
      parts: [
        { type: "thinking", text: "one" },
        { type: "thinking", text: " two", encrypted: "opaque" },
        { type: "text", text: "answer" },
      ],
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  }];

  assertEquals(eventsToMessages(events), [{
    role: "assistant",
    content: "answer",
    reasoningContent: "one two",
  }]);
  assertEquals(eventsToMessages(events, { keepThinking: "none" }), [{
    role: "assistant",
    content: "answer",
  }]);
});

Deno.test("runTurn: one tool round-trip then answer", async () => {
  const log = makeMemoryLog();
  const infra: AgentInfra = {
    event_log: log,
    provider: scriptedProvider([
      [
        {
          _tag: "ToolCall",
          id: "c1",
          name: "read",
          arguments: '{"path":"a.ts"}',
        },
        {
          _tag: "Finish",
          reason: "tool_calls",
          usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
        },
      ],
      [
        { _tag: "TextDelta", text: "done" },
        {
          _tag: "Finish",
          reason: "stop",
          usage: { promptTokens: 6, completionTokens: 1, totalTokens: 7 },
        },
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
    event_log: log,
    provider: scriptedProvider([
      [
        {
          _tag: "ToolCall",
          id: "c1",
          name: "bash",
          arguments: '{"command":"ls"}',
        },
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
    {
      ...base,
      type: "user.message",
      data: { parts: [{ type: "text", text: "u1" }] },
    },
    {
      ...base,
      type: "assistant.message",
      data: {
        parts: [{
          type: "tool_call",
          id: "t1",
          name: "write",
          input: { path: "x.ts" },
        }],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    },
    {
      ...base,
      type: "tool.call.requested",
      data: { callId: "t1", name: "write", input: { path: "x.ts" } },
    },
    {
      ...base,
      type: "tool.result",
      data: { callId: "t1", content: "ok", isError: false, durationMs: 1 },
    },
    {
      ...base,
      type: "user.message",
      data: { parts: [{ type: "text", text: "u2" }] },
    },
    {
      ...base,
      type: "user.message",
      data: { parts: [{ type: "text", text: "u3" }] },
    },
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

  // Fix B: isSummaryMessage recognises the SUMMARY_PREFIX marker.
  assertEquals(isSummaryMessage(`${SUMMARY_PREFIX}\nfoo`), true);
  assertEquals(isSummaryMessage("foo"), false);
});

// ---------------------------------------------------------------------------
// FIX A — provider error semantics & mid-stream retry
// ---------------------------------------------------------------------------

Deno.test("mid-stream Network error retries and discards partial text", async () => {
  const log = makeMemoryLog();
  const provider = flakyProvider([
    {
      events: [{ _tag: "TextDelta", text: "par" }],
      fail: new Network({ cause: new Error("boom") }),
    },
    {
      events: [
        { _tag: "TextDelta", text: "full answer" },
        { _tag: "Finish", reason: "stop" },
      ],
    },
  ]);
  const infra: AgentInfra = {
    event_log: log,
    provider,
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
  assertEquals(result.text, "full answer");
  assertEquals(result.stopReason, "stop");
  assertEquals(provider.calls(), 2);

  // Exactly one transient retry marker, retryable.
  const errs = log.dump(session.id).filter(isErrorOccurred);
  assertEquals(errs.length, 1);
  assertEquals(errs[0].data.retryable, true);

  // No assistant.message carries the discarded partial "par".
  const assistantJson = log.dump(session.id)
    .filter(isAssistantMessage)
    .map((e) => JSON.stringify(e.data.parts));
  assertEquals(assistantJson.some((s) => s.includes("par")), false);
});

Deno.test("text.reset emitted live before re-sample", async () => {
  const log = makeMemoryLog();
  const live: LiveEvent[] = [];
  const provider = flakyProvider([
    {
      events: [{ _tag: "TextDelta", text: "par" }],
      fail: new Network({ cause: new Error("boom") }),
    },
    {
      events: [
        { _tag: "TextDelta", text: "full answer" },
        { _tag: "Finish", reason: "stop" },
      ],
    },
  ]);
  const infra: AgentInfra = {
    event_log: log,
    provider,
    tools: noTools,
    approvals: makeApprovalGateway(log),
    defaultModel: "test-model",
    emitLive: (e) => live.push(e),
  };
  const mgr = new SessionManager(infra);
  const session = await Effect.runPromise(
    mgr.createAndRecord({ workspace: "/tmp/ws" }),
  );
  await Effect.runPromise(session.prompt([{ type: "text", text: "hi" }]));

  const idxPar = live.findIndex((e) =>
    e.type === "text.delta" && e.data.delta === "par"
  );
  const idxReset = live.findIndex((e) => e.type === "text.reset");
  const idxFull = live.findIndex((e) =>
    e.type === "text.delta" && e.data.delta === "full answer"
  );
  assertEquals(idxPar >= 0, true);
  assertEquals(idxReset >= 0, true);
  assertEquals(idxFull >= 0, true);
  assertEquals(idxPar < idxReset, true);
  assertEquals(idxReset < idxFull, true);
});

Deno.test("retry exhaustion ends turn with stopReason error", async () => {
  const log = makeMemoryLog();
  // 5 attempts (1 initial + STREAM_MAX_RETRIES=4), all RateLimited.
  const provider = flakyProvider([
    { events: [], fail: new RateLimited({}) },
    { events: [], fail: new RateLimited({}) },
    { events: [], fail: new RateLimited({}) },
    { events: [], fail: new RateLimited({}) },
    { events: [], fail: new RateLimited({}) },
  ]);
  const infra: AgentInfra = {
    event_log: log,
    provider,
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
  assertEquals(result.stopReason, "error");
  assertEquals(
    typeof result.error === "string" && result.error.length > 0,
    true,
  );
  assertEquals(result.error!.includes("RateLimited"), true);
  assertEquals(result.text, "");

  // 4 transient (retryable) retries precede the single terminal (non-retryable)
  // error.occurred, then a terminal turn.completed.
  const errs = log.dump(session.id).filter(isErrorOccurred);
  assertEquals(errs.length, 5);
  assertEquals(errs.filter((e) => e.data.retryable).length, 4);
  assertEquals(errs[4].data.retryable, false);
  const completed = log.dump(session.id).filter(isTurnCompleted);
  assertEquals(completed.length, 1);
  assertEquals(completed[0].data.stopReason, "error");
});

Deno.test("fatal provider error is not retried", async () => {
  const log = makeMemoryLog();
  const provider = flakyProvider([
    { events: [], fail: new AuthFailed({ message: "bad key" }) },
  ]);
  const infra: AgentInfra = {
    event_log: log,
    provider,
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
  assertEquals(provider.calls(), 1);
  assertEquals(result.stopReason, "error");
  const errs = log.dump(session.id).filter(isErrorOccurred);
  assertEquals(errs.length, 1);
  assertEquals(errs[0].data.retryable, false);
});

Deno.test("ContextOverflow force-compacts and re-samples", async () => {
  const log = makeMemoryLog();
  // Fix B: ContextOverflow now triggers an LLM summarizer call (via compactNow)
  // before the re-sample. Script: [0] main sample → ContextOverflow; [1]
  // summarizer → returns summary text (mode "llm"); [2] re-sample on the
  // compacted list → "recovered".
  const provider = flakyProvider([
    { events: [], fail: new ContextOverflow({}) },
    {
      events: [
        { _tag: "TextDelta", text: "LLM summary" },
        { _tag: "Finish", reason: "stop" },
      ],
    },
    {
      events: [
        { _tag: "TextDelta", text: "recovered" },
        { _tag: "Finish", reason: "stop" },
      ],
    },
  ]);
  const infra: AgentInfra = {
    event_log: log,
    provider,
    tools: noTools,
    approvals: makeApprovalGateway(log),
    defaultModel: "test-model",
  };
  const mgr = new SessionManager(infra);
  const session = await Effect.runPromise(
    mgr.createAndRecord({ workspace: "/tmp/ws" }),
  );
  // Seed >1 user turn so the ContextOverflow force-compact (keepUserTurns=1)
  // actually trims the prefix — compactMessages is a no-op while the user-turn
  // count stays <= keepUserTurns.
  for (const [u, a] of [["first", "ok1"], ["second", "ok2"]] as const) {
    await Effect.runPromise(log.append(session.id, {
      type: "user.message",
      data: { parts: [{ type: "text", text: u }] },
    }));
    await Effect.runPromise(log.append(session.id, {
      type: "assistant.message",
      data: {
        parts: [{ type: "text", text: a }],
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    }));
  }
  const result = await Effect.runPromise(
    session.prompt([{ type: "text", text: "go" }]),
  );
  assertEquals(result.text, "recovered");
  assertEquals(result.stopReason, "stop");

  const types = log.dump(session.id).map((e) => e.type);
  assertEquals(types.includes("compaction.performed"), true);

  // Three provider calls: main sample, summarizer, re-sample.
  assertEquals(provider.requests().length, 3);
  const firstCount = provider.requests()[0].messages.length;
  const resampleCount = provider.requests()[2].messages.length;
  assertEquals(resampleCount < firstCount, true);
});

// ---------------------------------------------------------------------------
// FIX D — incremental projection (replay once per turn)
// ---------------------------------------------------------------------------

Deno.test("runTurn replays the log once per turn (Fix D)", async () => {
  const log = makeMemoryLog();
  const provider = flakyProvider([
    {
      events: [
        {
          _tag: "ToolCall",
          id: "c1",
          name: "read",
          arguments: '{"path":"a.ts"}',
        },
        {
          _tag: "Finish",
          reason: "tool_calls",
          usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
        },
      ],
    },
    {
      events: [
        { _tag: "TextDelta", text: "done" },
        {
          _tag: "Finish",
          reason: "stop",
          usage: { promptTokens: 6, completionTokens: 1, totalTokens: 7 },
        },
      ],
    },
  ]);
  const infra: AgentInfra = {
    event_log: log,
    provider,
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
  // Two loop iterations (tool round-trip then answer) but exactly ONE replay.
  assertEquals(log.replayCalls(), 1);
});

Deno.test("incremental mirror matches full replay at each sample (Fix D)", async () => {
  const log = makeMemoryLog();
  const provider = flakyProvider([
    {
      events: [
        {
          _tag: "ToolCall",
          id: "c1",
          name: "read",
          arguments: '{"path":"a.ts"}',
        },
        {
          _tag: "Finish",
          reason: "tool_calls",
          usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
        },
      ],
    },
    {
      events: [
        { _tag: "TextDelta", text: "done" },
        {
          _tag: "Finish",
          reason: "stop",
          usage: { promptTokens: 6, completionTokens: 1, totalTokens: 7 },
        },
      ],
    },
  ]);
  const infra: AgentInfra = {
    event_log: log,
    provider,
    tools: noTools,
    approvals: makeApprovalGateway(log),
    defaultModel: "test-model",
  };
  const mgr = new SessionManager(infra);
  const session = await Effect.runPromise(
    mgr.createAndRecord({ workspace: "/tmp/ws" }),
  );
  await Effect.runPromise(
    session.prompt([{ type: "text", text: "read a.ts" }]),
  );

  // The second sample (after the tool result) saw a message list that must
  // equal a fresh eventsToMessages projection of the events logged up to that
  // sample: user → assistant(tool_call) → tool(result). The final
  // assistant.message ("done") was appended AFTER the second sample, so it is
  // excluded from the slice.
  const requests = provider.requests();
  assertEquals(requests.length, 2);
  const secondReqMessages = requests[1].messages;
  const messageEvents = log.dump(session.id).filter((e) =>
    e.type === "user.message" || e.type === "assistant.message" ||
    e.type === "tool.result"
  );
  assertEquals(
    secondReqMessages,
    eventsToMessages(messageEvents.slice(0, 3)),
  );
});

Deno.test("steered input is mirrored into the message list (Fix D)", async () => {
  const log = makeMemoryLog();
  const provider = flakyProvider([
    {
      events: [
        { _tag: "TextDelta", text: "ok" },
        { _tag: "Finish", reason: "stop" },
      ],
    },
  ]);
  const infra: AgentInfra = {
    event_log: log,
    provider,
    tools: noTools,
    approvals: makeApprovalGateway(log),
    defaultModel: "test-model",
  };
  const mgr = new SessionManager(infra);
  const session = await Effect.runPromise(
    mgr.createAndRecord({ workspace: "/tmp/ws" }),
  );
  // Seed a prior user message so the session has history, then steer extra
  // input that runTurn drains and appends at the loop top.
  await Effect.runPromise(log.append(session.id, {
    type: "user.message",
    data: { parts: [{ type: "text", text: "seed" }] },
  }));
  session.steer([{ type: "text", text: "extra" }]);
  await Effect.runPromise(session.run());

  const reqs = provider.requests();
  assertEquals(reqs.length, 1);
  const msgs = reqs[0].messages;
  // Steered "extra" appears as the final user message, after the seeded one.
  assertEquals(msgs.at(-1)!.role, "user");
  assertEquals(msgs.at(-1)!.content, "extra");
  assertEquals(msgs[0].content, "seed");
});

Deno.test("projectEvent: no-ops metadata, projects message types identically to eventsToMessages (Fix D)", () => {
  const base = { seq: 0, ts: 0, sessionId: "s" };
  const events: RecordedEvent[] = [
    { ...base, type: "turn.started", data: {} },
    {
      ...base,
      type: "user.message",
      data: { parts: [{ type: "text", text: "hi" }] },
    },
    {
      ...base,
      type: "assistant.message",
      data: {
        parts: [{
          type: "tool_call",
          id: "t1",
          name: "read",
          input: { path: "x" },
        }],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    },
    {
      ...base,
      type: "tool.call.requested",
      data: { callId: "t1", name: "read", input: { path: "x" } },
    },
    {
      ...base,
      type: "tool.result",
      data: { callId: "t1", content: "ok", isError: false, durationMs: 1 },
    },
    { ...base, type: "compaction.performed", data: {} },
    {
      ...base,
      type: "error.occurred",
      data: { message: "boom", retryable: false },
    },
  ];
  // Incremental projection (projectEvent per event) == full replay.
  const incremental: ProviderMessage[] = [];
  for (const ev of events) projectEvent(incremental, ev);
  assertEquals(incremental, eventsToMessages(events));
  // Only the three message-relevant types produce messages; metadata no-ops.
  assertEquals(incremental.length, 3);
  assertEquals(incremental[0].role, "user");
  assertEquals(incremental[1].role, "assistant");
  assertEquals(incremental[2].role, "tool");
});

// ---------------------------------------------------------------------------
// Orphan tool_call pairing (synthetic `aborted` outputs)
// ---------------------------------------------------------------------------

Deno.test("orphan tool_call at end of history gets synthetic aborted output", () => {
  const base = { seq: 0, ts: 0, sessionId: "s" };
  // Turn interrupted between the assistant message and the tool batch:
  // assistant carries a tool_call, no tool.result ever lands.
  const events: RecordedEvent[] = [
    {
      ...base,
      type: "user.message",
      data: { parts: [{ type: "text", text: "u1" }] },
    },
    {
      ...base,
      type: "assistant.message",
      data: {
        parts: [{
          type: "tool_call",
          id: "t1",
          name: "write",
          input: { path: "x" },
        }],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    },
    {
      ...base,
      type: "tool.call.requested",
      data: { callId: "t1", name: "write", input: { path: "x" } },
    },
    { ...base, type: "turn.aborted", data: { reason: "signal" } },
  ];
  const messages = eventsToMessages(events);
  assertEquals(messages.length, 3);
  assertEquals(messages[2].role, "tool");
  assertEquals(messages[2].toolCallId, "t1");
  assertEquals(messages[2].content, "aborted");
});

Deno.test("orphan tool_call is closed before the next user message", () => {
  const base = { seq: 0, ts: 0, sessionId: "s" };
  // The scenario that broke the live serve test: approval left pending, turn
  // never produces tool.result, then the user prompts again. The replay must
  // close the dangling call BEFORE the user message or the API 400s.
  const events: RecordedEvent[] = [
    {
      ...base,
      type: "user.message",
      data: { parts: [{ type: "text", text: "u1" }] },
    },
    {
      ...base,
      type: "assistant.message",
      data: {
        parts: [{
          type: "tool_call",
          id: "t1",
          name: "write",
          input: { path: "x" },
        }],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    },
    {
      ...base,
      type: "approval.requested",
      data: { approvalId: "a1", callId: "t1", name: "write", input: {} },
    },
    {
      ...base,
      type: "user.message",
      data: { parts: [{ type: "text", text: "u2" }] },
    },
    {
      ...base,
      type: "assistant.message",
      data: {
        parts: [{ type: "text", text: "ok" }],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    },
  ];
  const messages = eventsToMessages(events);
  // user, assistant(tool_call), tool(aborted), user, assistant
  assertEquals(messages.map((m) => m.role), [
    "user",
    "assistant",
    "tool",
    "user",
    "assistant",
  ]);
  assertEquals(messages[2].toolCallId, "t1");
  assertEquals(messages[2].content, "aborted");
});

Deno.test("multi-call batch with partial results closes only the missing calls", () => {
  const base = { seq: 0, ts: 0, sessionId: "s" };
  const events: RecordedEvent[] = [
    {
      ...base,
      type: "user.message",
      data: { parts: [{ type: "text", text: "u1" }] },
    },
    {
      ...base,
      type: "assistant.message",
      data: {
        parts: [
          { type: "tool_call", id: "t1", name: "read", input: { path: "a" } },
          { type: "tool_call", id: "t2", name: "read", input: { path: "b" } },
          { type: "tool_call", id: "t3", name: "write", input: { path: "c" } },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    },
    {
      ...base,
      type: "tool.result",
      data: { callId: "t1", content: "ra", isError: false, durationMs: 1 },
    },
    {
      ...base,
      type: "tool.result",
      data: { callId: "t2", content: "rb", isError: false, durationMs: 1 },
    },
    // t3 denied → reject path returns isError result; simulate its absence
    // (e.g. turn died right after t2) so t3 stays orphaned.
    {
      ...base,
      type: "user.message",
      data: { parts: [{ type: "text", text: "u2" }] },
    },
  ];
  const messages = eventsToMessages(events);
  const tools = messages.filter((m) => m.role === "tool");
  assertEquals(tools.length, 3);
  assertEquals(tools[0].toolCallId, "t1");
  assertEquals(tools[0].content, "ra");
  assertEquals(tools[1].toolCallId, "t2");
  assertEquals(tools[2].toolCallId, "t3");
  assertEquals(tools[2].content, "aborted");
  // Real results stay adjacent to their assistant message, before synthetics.
  assertEquals(messages.map((m) => m.role), [
    "user",
    "assistant",
    "tool",
    "tool",
    "tool",
    "user",
  ]);
});

Deno.test("orphan tool.result with no surviving call is dropped", () => {
  const base = { seq: 0, ts: 0, sessionId: "s" };
  // Compaction-style prefix loss: a tool.result whose assistant message was
  // cut from the window. Codex drops orphan outputs; so do we (no pending
  // call to home it to).
  const events: RecordedEvent[] = [
    {
      ...base,
      type: "tool.result",
      data: { callId: "ghost", content: "x", isError: false, durationMs: 1 },
    },
    {
      ...base,
      type: "user.message",
      data: { parts: [{ type: "text", text: "u1" }] },
    },
  ];
  const messages = eventsToMessages(events);
  assertEquals(messages.length, 1);
  assertEquals(messages[0].role, "user");
});

Deno.test("complete round-trips are untouched by pairing", () => {
  const base = { seq: 0, ts: 0, sessionId: "s" };
  const events: RecordedEvent[] = [
    {
      ...base,
      type: "user.message",
      data: { parts: [{ type: "text", text: "u1" }] },
    },
    {
      ...base,
      type: "assistant.message",
      data: {
        parts: [{
          type: "tool_call",
          id: "t1",
          name: "read",
          input: { path: "a" },
        }],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    },
    {
      ...base,
      type: "tool.result",
      data: { callId: "t1", content: "ok", isError: false, durationMs: 1 },
    },
    {
      ...base,
      type: "assistant.message",
      data: {
        parts: [{ type: "text", text: "done" }],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    },
  ];
  const messages = eventsToMessages(events);
  assertEquals(messages.map((m) => m.role), [
    "user",
    "assistant",
    "tool",
    "assistant",
  ]);
  assertEquals(messages[2].content, "ok");
});

// ---------------------------------------------------------------------------
// FIX B — LLM-written compaction summary with template fallback
// ---------------------------------------------------------------------------
//
// All compaction tests use defaultContextWindow: 40 so the threshold (34
// tokens) is tripped by the real system prompt alone. The summarizer is an
// EXTRA provider call before the main sample; flakyProvider indexes scripts
// by call order so [0] = summarizer, [1] = compacted answer. Seeded user
// turns ensure compactMessages(keepUserTurns=2) actually trims the prefix
// and prepends the summary as messages[0].

// Seed N user+assistant turns directly into the log so compactMessages has
// enough user turns to trim. Returns nothing — the events live in `log`.
async function seedTurns(
  log: EventLog,
  sessionId: string,
  turns: ReadonlyArray<[string, string]>,
): Promise<void> {
  for (const [u, a] of turns) {
    await Effect.runPromise(log.append(sessionId, {
      type: "user.message",
      data: { parts: [{ type: "text", text: u }] },
    }));
    await Effect.runPromise(log.append(sessionId, {
      type: "assistant.message",
      data: {
        parts: [{ type: "text", text: a }],
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    }));
  }
}

Deno.test("compaction over threshold uses LLM summary (Fix B)", async () => {
  const log = makeMemoryLog();
  const provider = flakyProvider([
    {
      events: [
        { _tag: "TextDelta", text: "LLM SUMMARY" },
        { _tag: "Finish", reason: "stop" },
      ],
    },
    {
      events: [
        { _tag: "TextDelta", text: "answer" },
        { _tag: "Finish", reason: "stop" },
      ],
    },
  ]);
  const infra: AgentInfra = {
    event_log: log,
    provider,
    tools: noTools,
    approvals: makeApprovalGateway(log),
    defaultModel: "test-model",
    defaultContextWindow: 40,
  };
  const mgr = new SessionManager(infra);
  const session = await Effect.runPromise(
    mgr.createAndRecord({ workspace: "/tmp/ws" }),
  );
  await seedTurns(log, session.id, [["u1", "r1"], ["u2", "r2"], ["u3", "r3"]]);
  const result = await Effect.runPromise(
    session.prompt([{ type: "text", text: "go" }]),
  );
  assertEquals(result.text, "answer");

  // compaction.performed recorded with mode "llm".
  const compactions = log.dump(session.id).filter((e) =>
    e.type === "compaction.performed"
  );
  assertEquals(compactions.length >= 1, true);
  const cp = compactions[0];
  assertEquals(cp?.type === "compaction.performed" && cp.data.mode, "llm");

  // The second request (compacted answer) has the LLM summary as messages[0].
  const reqs = provider.requests();
  assertEquals(reqs.length, 2);
  const content = reqs[1].messages[0].content;
  assertEquals(content.startsWith(SUMMARY_PREFIX), true);
  assertEquals(content.includes("LLM SUMMARY"), true);
});

Deno.test("summary call failure falls back to template (Fix B)", async () => {
  const log = makeMemoryLog();
  const provider = flakyProvider([
    { events: [], fail: new Network({ cause: new Error("x") }) },
    {
      events: [
        { _tag: "TextDelta", text: "answer" },
        { _tag: "Finish", reason: "stop" },
      ],
    },
  ]);
  const infra: AgentInfra = {
    event_log: log,
    provider,
    tools: noTools,
    approvals: makeApprovalGateway(log),
    defaultModel: "test-model",
    defaultContextWindow: 40,
  };
  const mgr = new SessionManager(infra);
  const session = await Effect.runPromise(
    mgr.createAndRecord({ workspace: "/tmp/ws" }),
  );
  await seedTurns(log, session.id, [["u1", "r1"], ["u2", "r2"], ["u3", "r3"]]);
  const result = await Effect.runPromise(
    session.prompt([{ type: "text", text: "go" }]),
  );
  assertEquals(result.text, "answer");

  const compactions = log.dump(session.id).filter((e) =>
    e.type === "compaction.performed"
  );
  assertEquals(compactions.length >= 1, true);
  const cp = compactions[0];
  assertEquals(cp?.type === "compaction.performed" && cp.data.mode, "template");

  const reqs = provider.requests();
  assertEquals(reqs.length, 2);
  const content = reqs[1].messages[0].content;
  assertEquals(content.startsWith(SUMMARY_PREFIX), true);
  assertEquals(content.includes("Conversation summary"), true);
});

Deno.test("empty summary falls back to template (Fix B)", async () => {
  const log = makeMemoryLog();
  // Summarizer returns Finish with no TextDelta → summarizeHistory yields null.
  const provider = flakyProvider([
    { events: [{ _tag: "Finish", reason: "stop" }] },
    {
      events: [
        { _tag: "TextDelta", text: "answer" },
        { _tag: "Finish", reason: "stop" },
      ],
    },
  ]);
  const infra: AgentInfra = {
    event_log: log,
    provider,
    tools: noTools,
    approvals: makeApprovalGateway(log),
    defaultModel: "test-model",
    defaultContextWindow: 40,
  };
  const mgr = new SessionManager(infra);
  const session = await Effect.runPromise(
    mgr.createAndRecord({ workspace: "/tmp/ws" }),
  );
  await seedTurns(log, session.id, [["u1", "r1"], ["u2", "r2"], ["u3", "r3"]]);
  const result = await Effect.runPromise(
    session.prompt([{ type: "text", text: "go" }]),
  );
  assertEquals(result.text, "answer");

  const compactions = log.dump(session.id).filter((e) =>
    e.type === "compaction.performed"
  );
  assertEquals(compactions.length >= 1, true);
  const cp = compactions[0];
  assertEquals(cp?.type === "compaction.performed" && cp.data.mode, "template");
});

Deno.test("summarizeHistory: appends prompt as final user message, no tools (Fix B)", async () => {
  let captured: ChatRequest | undefined;
  const provider: ProviderAdapter = {
    listModels: () => Effect.succeed([] as ReadonlyArray<ModelRef>),
    stream: (req) => {
      captured = req;
      return Stream.fromArray(
        [{ _tag: "Finish", reason: "stop" }] as ProviderStreamEvent[],
      );
    },
  };
  const messages: ProviderMessage[] = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
  ];
  const result = await Effect.runPromise(
    summarizeHistory({ provider, model: "m" }, messages),
  );
  // No TextDelta emitted → null.
  assertEquals(result, null);
  assertEquals(captured !== undefined, true);
  if (captured) {
    // No tools, no system prompt.
    assertEquals(captured.tools.length, 0);
    assertEquals(captured.system, undefined);
    // The prompt is appended as the final user message.
    const last = captured.messages.at(-1)!;
    assertEquals(last.role, "user");
    assertEquals(last.content, SUMMARIZATION_PROMPT);
    // Original messages precede the prompt.
    assertEquals(captured.messages.length, messages.length + 1);
    assertEquals(captured.messages[0].content, "hello");
  }
});
