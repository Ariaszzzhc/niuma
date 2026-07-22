import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { Schema } from "effect";
import {
  Decision,
  LiveEvent,
  Message,
  Part,
  RecordedEvent,
  Role,
  RuleAction,
  SessionStatus,
  SseEvent,
  StopReason,
  StreamEvent,
  ToolDef,
  ToolParameters,
  ToolResultContent,
  ApprovalDecisionType,
  parseEventLine,
  stringifyEventLine,
} from "../mod.ts";

// Locks the effect@4.0.0-beta.100 Schema API contract that @niuma/schema relies
// on. Regressions of the original bug (variadic Schema.Literal / Schema.Union,
// missing Schema.UnknownRecord) will fail these assertions at module load or on
// the first decode.

const dec = Schema.decodeUnknownSync;
const enc = Schema.encodeUnknownSync;

Deno.test("Role: multi-value Literals enumerates every role, not just the first", () => {
  // The old variadic Literal("system","user","assistant","tool") silently
  // validated ONLY "system" (extras dropped). All four must now decode.
  for (const r of ["system", "user", "assistant", "tool"] as const) {
    assertEquals(dec(Role)(r), r);
  }
  // Bogus values must be rejected — proves the literal is closed.
  assertRejectsSync(() => dec(Role)("wizard"));
});

Deno.test("StopReason: all five stop reasons decode", () => {
  for (const r of ["stop", "length", "tool_calls", "content_filter", "abort"] as const) {
    assertEquals(dec(StopReason)(r), r);
  }
  assertRejectsSync(() => dec(StopReason)("nope"));
});

Deno.test("RuleAction / SessionStatus / ApprovalDecisionType: multi-value literals enumerate fully", () => {
  for (const a of ["allow", "deny", "ask"] as const) assertEquals(dec(RuleAction)(a), a);
  for (const s of ["idle", "running", "waiting_approval", "aborted"] as const) {
    assertEquals(dec(SessionStatus)(s), s);
  }
  for (const d of ["once", "always", "reject"] as const) {
    assertEquals(dec(ApprovalDecisionType)(d), d);
  }
  assertRejectsSync(() => dec(RuleAction)("maybe"));
  assertRejectsSync(() => dec(SessionStatus)("unknown"));
  assertRejectsSync(() => dec(ApprovalDecisionType)("forever"));
});

Deno.test("ToolParameters (Schema.Record replacement): arbitrary JSON object accepted", () => {
  // Replaces the old `Schema.UnknownRecord` which was undefined at runtime.
  assertEquals(dec(ToolParameters)({ type: "object", properties: {} }), {
    type: "object",
    properties: {},
  });
});

Deno.test("ToolResultContent / Part / Decision / LiveEvent / SseEvent / RecordedEvent / StreamEvent: array-form Unions decode each member", () => {
  // Each of these was a variadic Schema.Union(A, B, ...) that crashed at
  // import with `members.map is not a function`. Now they must accept every arm.
  assertEquals(dec(ToolResultContent)("plain string"), "plain string");
  assertEquals(dec(ToolResultContent)([{ type: "text", text: "x" }]), [
    { type: "text", text: "x" },
  ]);

  assertEquals(dec(Part)({ type: "text", text: "hi" }), { type: "text", text: "hi" });
  assertEquals(dec(Part)({
    type: "tool_call",
    id: "c1",
    name: "bash",
    input: { cmd: "ls" },
  }), { type: "tool_call", id: "c1", name: "bash", input: { cmd: "ls" } });
  assertEquals(dec(Part)({
    type: "tool_result",
    toolCallId: "c1",
    content: "ok",
    isError: false,
  }), { type: "tool_result", toolCallId: "c1", content: "ok", isError: false });

  assertEquals(dec(Decision)({ decision: "allow" }), { decision: "allow" });
  assertEquals(dec(Decision)({ decision: "deny", reason: "no" }), {
    decision: "deny",
    reason: "no",
  });
  assertEquals(dec(Decision)({ decision: "ask" }), { decision: "ask" });

  assertEquals(dec(LiveEvent)({
    ts: 1,
    sessionId: "s",
    type: "text.delta",
    data: { delta: "x" },
  }), { ts: 1, sessionId: "s", type: "text.delta", data: { delta: "x" } });
  assertEquals(dec(LiveEvent)({
    ts: 1,
    sessionId: "s",
    type: "tool.progress",
    data: { callId: "c1", message: "running" },
  }), { ts: 1, sessionId: "s", type: "tool.progress", data: { callId: "c1", message: "running" } });

  // SseEvent nests the array-form Union of (RecordedEvent | LiveEvent).
  assertEquals(dec(SseEvent)({
    cursor: 5,
    event: {
      ts: 1,
      sessionId: "s",
      type: "text.delta",
      data: { delta: "x" },
    },
  }), {
    cursor: 5,
    event: {
      ts: 1,
      sessionId: "s",
      type: "text.delta",
      data: { delta: "x" },
    },
  });

  // RecordedEvent: one of each arm is exercised in the round-trip test below;
  // here we just prove the union decodes a sample.
  assertEquals(dec(RecordedEvent)({
    seq: 1,
    ts: 1,
    sessionId: "s",
    type: "session.created",
    data: { workspace: "/w", model: "m" },
  }), {
    seq: 1,
    ts: 1,
    sessionId: "s",
    type: "session.created",
    data: { workspace: "/w", model: "m" },
  });

  // StreamEvent: provider-side flat union.
  assertEquals(dec(StreamEvent)({ type: "text.delta", delta: "x" }), {
    type: "text.delta",
    delta: "x",
  });
  assertEquals(dec(StreamEvent)({
    type: "message.done",
    usage: { inputTokens: 1, outputTokens: 2 },
    stopReason: "stop",
  }), {
    type: "message.done",
    usage: { inputTokens: 1, outputTokens: 2 },
    stopReason: "stop",
  });
});

Deno.test("Message: assistant role round-trips (regression for Role Literals bug)", () => {
  const msg = {
    role: "assistant" as const,
    parts: [{ type: "text" as const, text: "hello" }],
  };
  const roundtrip = dec(Message)(enc(Message)(msg));
  assertEquals(roundtrip, msg);
});

Deno.test("ToolDef: encodes with arbitrary JSON-Schema parameters object", () => {
  const def = {
    name: "bash",
    description: "run a shell command",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  };
  assertEquals(dec(ToolDef)(def), def);
});

// One sample per RecordedEvent variant — proves every event arm in the union
// round-trips through the JSONL helpers. Locks the closed literal on each
// `type` field AND the union decoding.
Deno.test("parseEventLine/stringifyEventLine: round-trip every RecordedEvent variant", () => {
  const samples: ReadonlyArray<Schema.Schema.Type<typeof RecordedEvent>> = [
    { seq: 1, ts: 1, sessionId: "s", type: "session.created", data: { workspace: "/w", model: "m" } },
    { seq: 2, ts: 2, sessionId: "s", type: "user.message", data: { parts: [{ type: "text", text: "hi" }] } },
    {
      seq: 3, ts: 3, sessionId: "s", type: "assistant.message",
      data: { parts: [{ type: "text", text: "hello" }], usage: { inputTokens: 1, outputTokens: 2 } },
    },
    { seq: 4, ts: 4, sessionId: "s", type: "tool.call.requested", data: { callId: "c1", name: "bash", input: { cmd: "ls" } } },
    { seq: 5, ts: 5, sessionId: "s", type: "tool.call.approved", data: { callId: "c1", reason: "ok" } },
    { seq: 6, ts: 6, sessionId: "s", type: "tool.call.denied", data: { callId: "c1", reason: "no" } },
    { seq: 7, ts: 7, sessionId: "s", type: "tool.result", data: { callId: "c1", content: "done", isError: false, durationMs: 10 } },
    { seq: 8, ts: 8, sessionId: "s", type: "turn.started", data: {} },
    { seq: 9, ts: 9, sessionId: "s", type: "turn.completed", data: { stopReason: "stop", usage: { inputTokens: 1, outputTokens: 2 } } },
    { seq: 10, ts: 10, sessionId: "s", type: "turn.aborted", data: { reason: "user" } },
    { seq: 11, ts: 11, sessionId: "s", type: "compaction.performed", data: {} },
    { seq: 12, ts: 12, sessionId: "s", type: "approval.requested", data: { approvalId: "a1", callId: "c1", name: "bash", input: { cmd: "rm" } } },
    { seq: 13, ts: 13, sessionId: "s", type: "approval.resolved", data: { approvalId: "a1", decision: "once" } },
    { seq: 14, ts: 14, sessionId: "s", type: "subagent.spawned", data: { parentSessionId: "p", childSessionId: "c", prompt: "go" } },
    { seq: 15, ts: 15, sessionId: "s", type: "error.occurred", data: { message: "boom", retryable: false } },
  ];
  assertEquals(samples.length, 15);

  for (const ev of samples) {
    const line = stringifyEventLine(ev);
    const back = parseEventLine(line);
    const backLine = stringifyEventLine(back);
    assertEquals(backLine, line, `round-trip mismatch for ${ev.type}`);
    assertEquals(back, ev, `decode mismatch for ${ev.type}`);
  }
});

Deno.test("parseEventLine: rejects unknown event type (closed RecordedEventType literal)", () => {
  // A bogus `type` must be rejected — this is what makes the event log
  // append-only / typed. Locks the multi-value RecordedEventType Literals.
  const bogus = JSON.stringify({
    seq: 1,
    ts: 1,
    sessionId: "s",
    type: "no.such.event",
    data: {},
  });
  assertRejectsSync(() => parseEventLine(bogus));
});

// deno-lint-ignore no-explicit-any
function assertRejectsSync(fn: () => any): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) {
    throw new Error("Expected function to throw, but it did not");
  }
}
