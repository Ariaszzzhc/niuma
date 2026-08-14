import { assertEquals } from "@std/assert";
import { Schema } from "effect";
import {
  ApprovalDecisionType,
  ClientConfigView,
  CreateSessionRes,
  Decision,
  InterruptRes,
  LiveEvent,
  parseEventLine,
  Part,
  PromptRes,
  RecordedEvent,
  RuleAction,
  SessionStatus,
  SetInputDeliveryReq,
  SetInputDeliveryRes,
  SseEvent,
  StopReason,
  stringifyEventLine,
  ThinkingPart,
  ToolResultContent,
} from "../mod.ts";

// Locks the effect@4.0.0-beta.100 Schema API contract that @niuma/schema relies
// on. Regressions of the original bug (variadic Schema.Literal / Schema.Union,
// missing Schema.UnknownRecord) will fail these assertions at module load or on
// the first decode.

const dec = Schema.decodeUnknownSync;
const enc = Schema.encodeUnknownSync;

Deno.test("StopReason: all five stop reasons decode", () => {
  for (
    const r of [
      "stop",
      "length",
      "tool_calls",
      "content_filter",
      "abort",
    ] as const
  ) {
    assertEquals(dec(StopReason)(r), r);
  }
  assertRejectsSync(() => dec(StopReason)("nope"));
});

Deno.test("RuleAction / SessionStatus / ApprovalDecisionType: multi-value literals enumerate fully", () => {
  for (const a of ["allow", "deny", "ask"] as const) {
    assertEquals(dec(RuleAction)(a), a);
  }
  for (const s of ["idle", "running", "waiting_approval"] as const) {
    assertEquals(dec(SessionStatus)(s), s);
  }
  for (const d of ["once", "always", "reject"] as const) {
    assertEquals(dec(ApprovalDecisionType)(d), d);
  }
  assertRejectsSync(() => dec(RuleAction)("maybe"));
  assertRejectsSync(() => dec(SessionStatus)("unknown"));
  assertRejectsSync(() => dec(ApprovalDecisionType)("forever"));
});

Deno.test("ToolResultContent / Part / Decision / LiveEvent / SseEvent / RecordedEvent: array-form Unions decode each member", () => {
  // Each of these was a variadic Schema.Union(A, B, ...) that crashed at
  // import with `members.map is not a function`. Now they must accept every arm.
  assertEquals(dec(ToolResultContent)("plain string"), "plain string");
  assertEquals(dec(ToolResultContent)([{ type: "text", text: "x" }]), [
    { type: "text", text: "x" },
  ]);

  assertEquals(dec(Part)({ type: "text", text: "hi" }), {
    type: "text",
    text: "hi",
  });
  assertEquals(
    dec(Part)({
      type: "tool_call",
      id: "c1",
      name: "bash",
      input: { cmd: "ls" },
    }),
    { type: "tool_call", id: "c1", name: "bash", input: { cmd: "ls" } },
  );
  assertEquals(
    dec(Part)({
      type: "tool_result",
      toolCallId: "c1",
      content: "ok",
      isError: false,
    }),
    { type: "tool_result", toolCallId: "c1", content: "ok", isError: false },
  );

  assertEquals(dec(Decision)({ decision: "allow" }), { decision: "allow" });
  assertEquals(dec(Decision)({ decision: "deny", reason: "no" }), {
    decision: "deny",
    reason: "no",
  });
  assertEquals(dec(Decision)({ decision: "ask" }), { decision: "ask" });

  assertEquals(
    dec(LiveEvent)({
      ts: 1,
      sessionId: "s",
      type: "text.delta",
      data: { delta: "x" },
    }),
    { ts: 1, sessionId: "s", type: "text.delta", data: { delta: "x" } },
  );
  assertEquals(
    dec(LiveEvent)({
      ts: 1,
      sessionId: "s",
      type: "tool.progress",
      data: { callId: "c1", message: "running" },
    }),
    {
      ts: 1,
      sessionId: "s",
      type: "tool.progress",
      data: { callId: "c1", message: "running" },
    },
  );
  assertEquals(
    dec(LiveEvent)({
      ts: 2,
      sessionId: "s",
      type: "input.recovered",
      data: {
        reason: "turn_failed",
        inputs: [{ sourceText: "first" }, { sourceText: "second" }],
      },
    }),
    {
      ts: 2,
      sessionId: "s",
      type: "input.recovered",
      data: {
        reason: "turn_failed",
        inputs: [{ sourceText: "first" }, { sourceText: "second" }],
      },
    },
  );

  // SseEvent nests the array-form Union of (RecordedEvent | LiveEvent).
  assertEquals(
    dec(SseEvent)({
      cursor: 5,
      event: {
        ts: 1,
        sessionId: "s",
        type: "text.delta",
        data: { delta: "x" },
      },
    }),
    {
      cursor: 5,
      event: {
        ts: 1,
        sessionId: "s",
        type: "text.delta",
        data: { delta: "x" },
      },
    },
  );

  // RecordedEvent: one of each arm is exercised in the round-trip test below;
  // here we just prove the union decodes a sample.
  assertEquals(
    dec(RecordedEvent)({
      seq: 1,
      ts: 1,
      sessionId: "s",
      type: "session.created",
      data: { workspace: "/w", model: "m", mcpServers: [] },
    }),
    {
      seq: 1,
      ts: 1,
      sessionId: "s",
      type: "session.created",
      data: { workspace: "/w", model: "m", mcpServers: [] },
    },
  );
});

Deno.test("prompt delivery protocol is closed and carries the server config view", () => {
  assertEquals(dec(ClientConfigView)({ inputDelivery: "steer" }), {
    inputDelivery: "steer",
  });
  assertEquals(dec(SetInputDeliveryReq)({ inputDelivery: "queue" }), {
    inputDelivery: "queue",
  });
  assertEquals(
    dec(SetInputDeliveryRes)({
      ok: true,
      config: { inputDelivery: "queue" },
    }),
    { ok: true, config: { inputDelivery: "queue" } },
  );
  for (const disposition of ["started", "steered", "queued"] as const) {
    assertEquals(dec(PromptRes)({ disposition }), { disposition });
  }
  assertEquals(
    dec(InterruptRes)({
      ok: true,
      returnedInputs: [{ sourceText: "restore me" }],
    }),
    { ok: true, returnedInputs: [{ sourceText: "restore me" }] },
  );
  assertEquals(
    dec(CreateSessionRes)({
      sessionId: "s",
      workspace: "/w",
      model: "m",
      mcpServers: [],
      commands: [],
      clientConfig: { inputDelivery: "steer" },
    }).clientConfig,
    { inputDelivery: "steer" },
  );

  assertRejectsSync(() => dec(ClientConfigView)({ inputDelivery: "replace" }));
  assertRejectsSync(() => dec(PromptRes)({ disposition: "accepted" }));
  assertRejectsSync(() =>
    dec(InterruptRes)({ ok: true, returnedInputs: ["not structured"] })
  );
});

// One sample per RecordedEvent variant — proves every event arm in the union
// round-trips through the JSONL helpers. Locks the closed literal on each
// `type` field AND the union decoding.
Deno.test("parseEventLine/stringifyEventLine: round-trip every RecordedEvent variant", () => {
  const samples: ReadonlyArray<Schema.Schema.Type<typeof RecordedEvent>> = [
    {
      seq: 1,
      ts: 1,
      sessionId: "s",
      type: "session.created",
      data: { workspace: "/w", model: "m", mcpServers: [] },
    },
    {
      seq: 2,
      ts: 2,
      sessionId: "s",
      type: "user.message",
      data: { parts: [{ type: "text", text: "hi" }] },
    },
    {
      seq: 3,
      ts: 3,
      sessionId: "s",
      type: "assistant.message",
      data: {
        parts: [{ type: "text", text: "hello" }],
      },
    },
    {
      seq: 4,
      ts: 4,
      sessionId: "s",
      type: "tool.call.requested",
      data: { callId: "c1", name: "bash", input: { cmd: "ls" } },
    },
    {
      seq: 5,
      ts: 5,
      sessionId: "s",
      type: "tool.call.approved",
      data: { callId: "c1", reason: "ok" },
    },
    {
      seq: 6,
      ts: 6,
      sessionId: "s",
      type: "tool.call.denied",
      data: { callId: "c1", reason: "no" },
    },
    {
      seq: 7,
      ts: 7,
      sessionId: "s",
      type: "tool.result",
      data: { callId: "c1", content: "done", isError: false, durationMs: 10 },
    },
    {
      seq: 8,
      ts: 8,
      sessionId: "s",
      type: "turn.started",
      data: { turnId: "t1" },
    },
    {
      seq: 9,
      ts: 9,
      sessionId: "s",
      type: "turn.completed",
      data: { turnId: "t1", stopReason: "stop" },
    },
    {
      seq: 10,
      ts: 10,
      sessionId: "s",
      type: "turn.aborted",
      data: { turnId: "t1", reason: "user" },
    },
    {
      seq: 11,
      ts: 11,
      sessionId: "s",
      type: "compaction.performed",
      data: {
        summaryMessageId: "summary-1",
        mode: "template",
        summary: "summary",
      },
    },
    {
      seq: 12,
      ts: 12,
      sessionId: "s",
      type: "approval.requested",
      data: {
        approvalId: "a1",
        callId: "c1",
        name: "bash",
        input: { cmd: "rm" },
      },
    },
    {
      seq: 13,
      ts: 13,
      sessionId: "s",
      type: "approval.resolved",
      data: { approvalId: "a1", decision: "once" },
    },
    {
      seq: 14,
      ts: 14,
      sessionId: "s",
      type: "subagent.spawned",
      data: {
        parentSessionId: "p",
        childSessionId: "c",
        prompt: "go",
        name: "scout",
        callId: "c1",
      },
    },
    {
      seq: 15,
      ts: 15,
      sessionId: "s",
      type: "error.occurred",
      data: { message: "boom", retryable: false },
    },
    {
      seq: 16,
      ts: 16,
      sessionId: "s",
      type: "session.model.changed",
      data: { model: "openai/gpt-5", contextWindow: 400_000 },
    },
    {
      seq: 17,
      ts: 17,
      sessionId: "s",
      type: "session.effort.changed",
      data: { effort: "high" },
    },
    {
      seq: 18,
      ts: 18,
      sessionId: "s",
      type: "model.call.completed",
      data: {
        callId: "mc1",
        turnId: "t1",
        purpose: "agent",
        actor: "main",
        providerId: "openai",
        modelId: "gpt-5",
        billingMode: "subscription",
        durationMs: 10,
        attempts: 1,
        finishReason: "stop",
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          reasoningTokens: null,
          cachedInputTokens: null,
          cacheWriteTokens: null,
        },
      },
    },
    {
      seq: 19,
      ts: 19,
      sessionId: "s",
      type: "model.call.failed",
      data: {
        callId: "mc2",
        turnId: "t1",
        purpose: "compaction",
        actor: "main",
        providerId: "openai",
        modelId: "gpt-5",
        billingMode: "subscription",
        durationMs: 10,
        attempts: 2,
        error: "Overloaded",
      },
    },
  ];
  assertEquals(samples.length, 19);

  for (const ev of samples) {
    const line = stringifyEventLine(ev);
    const back = parseEventLine(line);
    const backLine = stringifyEventLine(back);
    assertEquals(backLine, line, `round-trip mismatch for ${ev.type}`);
    assertEquals(back, ev, `decode mismatch for ${ev.type}`);
  }
});

Deno.test("parseEventLine: rejects unknown event type (closed RecordedEventType literal)", () => {
  // A bogus `type` must be rejected — this is what makes the Session Journal
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

// ============================================================================
// Thinking / reasoning support — plans §3, §8, §9.
// ThinkingPart + thinking.delta live event are the schema's surface for the
// provider-neutral reasoning abstraction (text + opaque `encrypted` credential
// the client must never surface as text). `encrypted` is OPTIONAL so JSONL
// written before the thinking feature round-trips unchanged.
// ============================================================================

Deno.test("ThinkingPart: decodes with the opaque encrypted credential", () => {
  // `encrypted` is opaque to niuma — providers (Anthropic signature,
  // Responses encrypted_content, …) stash their re-submit credential here.
  // The schema just keeps the string opaque; nothing decodes its content.
  const wire: Schema.Schema.Type<typeof ThinkingPart> = {
    type: "thinking",
    text: "let me reason",
    encrypted: "sig-abc123",
  };
  assertEquals(dec(ThinkingPart)(wire), wire);
});

Deno.test("ThinkingPart: omits encrypted when not present", () => {
  // Old assistant.message events were written before the thinking feature
  // shipped: their parts only contain text / tool_call / tool_result. The
  // schema treats `encrypted` as optional, so a thinking part authored by a
  // provider that does not emit a credential must decode without it.
  const wire: Schema.Schema.Type<typeof ThinkingPart> = {
    type: "thinking",
    text: "plain reasoning",
  };
  assertEquals(dec(ThinkingPart)(wire), wire);
  // And a re-encode of that decoded value must not invent an `encrypted` key.
  assertEquals(enc(ThinkingPart)(wire), wire);
});

Deno.test("Part union: ThinkingPart is selected when type=thinking and decodes through Part", () => {
  // Locks that adding ThinkingPart to the `Part` union did not shadow the
  // existing text/tool_call/tool_result arms. Each member still has to round-
  // trip through the union.
  const withEnc: Schema.Schema.Type<typeof Part> = {
    type: "thinking",
    text: "t",
    encrypted: "e",
  };
  assertEquals(dec(Part)(withEnc), withEnc);
  const plain: Schema.Schema.Type<typeof Part> = {
    type: "thinking",
    text: "t",
  };
  assertEquals(dec(Part)(plain), plain);
  // Bogus `encrypted` (non-string) is still rejected.
  assertRejectsSync(() =>
    dec(Part)({ type: "thinking", text: "x", encrypted: 42 })
  );
});

Deno.test("thinking.delta live event round-trips through LiveEvent encode/decode", () => {
  // live envelope shape: { ts, sessionId, type, data }. The data payload is
  // a single `delta` string — never carries `encrypted` (the live stream
  // surfaces only the human-readable reasoning; the credential travels in the
  // final ThinkingPart of the assistant.message, not in delta frames).
  const frame: Schema.Schema.Type<typeof LiveEvent> = {
    ts: 1,
    sessionId: "s",
    type: "thinking.delta",
    data: { delta: "thinking…" },
  };
  assertEquals(dec(LiveEvent)(frame), frame);
  assertEquals(enc(LiveEvent)(frame), frame);
});

Deno.test("LiveEvent: thinking.delta decodes alongside text.delta and text.reset (union intact)", () => {
  // Sanity: the new arm joined an existing union — none of the previously-
  // supported arms regressed.
  assertEquals(
    dec(LiveEvent)({
      ts: 1,
      sessionId: "s",
      type: "text.delta",
      data: { delta: "x" },
    }),
    { ts: 1, sessionId: "s", type: "text.delta", data: { delta: "x" } },
  );
  assertEquals(
    dec(LiveEvent)({
      ts: 1,
      sessionId: "s",
      type: "text.reset",
      data: {},
    }),
    { ts: 1, sessionId: "s", type: "text.reset", data: {} },
  );
  // A bogus live type is still rejected.
  assertRejectsSync(() =>
    dec(LiveEvent)({
      ts: 1,
      sessionId: "s",
      type: "thinking.bogus",
      data: { delta: "x" },
    })
  );
});

Deno.test("parseEventLine/stringifyEventLine: assistant.message with a ThinkingPart round-trips", () => {
  // The recorded assistant.message envelope is how the thinking part reaches
  // a reconnected client. The full round-trip exercises both the Part union
  // selection and the JSONL helper. encrypted MUST survive verbatim across
  // the encode/decode cycle — providers depend on it for re-submission.
  const withThinking: Schema.Schema.Type<typeof RecordedEvent> = {
    seq: 100,
    ts: 1000,
    sessionId: "s",
    type: "assistant.message",
    data: {
      parts: [
        { type: "thinking", text: "first ", encrypted: "sig-1" },
        { type: "text", text: "answer" },
        { type: "thinking", text: "second" },
      ],
    },
  };
  const line = stringifyEventLine(withThinking);
  const back = parseEventLine(line);
  assertEquals(back, withThinking);
  // Spot-check: a text-only assistant message still parses.
  const textOnly: Schema.Schema.Type<typeof RecordedEvent> = {
    seq: 1,
    ts: 1,
    sessionId: "s",
    type: "assistant.message",
    data: {
      parts: [{ type: "text", text: "hi" }],
    },
  };
  assertEquals(parseEventLine(stringifyEventLine(textOnly)), textOnly);
});

Deno.test("subagent observability: created.parentSessionId, spawned.callId and subagent.completed round-trip", () => {
  const created = {
    seq: 1,
    ts: 1,
    sessionId: "child",
    type: "session.created" as const,
    data: {
      workspace: "/w",
      model: "m",
      mcpServers: [],
      parentSessionId: "parent",
    },
  };
  const spawned = {
    seq: 1,
    ts: 2,
    sessionId: "parent",
    type: "subagent.spawned" as const,
    data: {
      parentSessionId: "parent",
      childSessionId: "child",
      prompt: "p",
      name: "explorer",
      callId: "call-1",
    },
  };
  const completed = {
    seq: 2,
    ts: 3,
    sessionId: "parent",
    type: "subagent.completed" as const,
    data: {
      parentSessionId: "parent",
      childSessionId: "child",
      callId: "call-1",
      ok: true,
      usage: { inputTokens: 10, outputTokens: 20 },
      durationMs: 1500,
    },
  };
  for (const event of [created, spawned, completed]) {
    assertEquals(parseEventLine(stringifyEventLine(event)), event);
  }
});

Deno.test("session.created without parentSessionId decodes (top-level session)", () => {
  const created = {
    seq: 1,
    ts: 1,
    sessionId: "s",
    type: "session.created" as const,
    data: { workspace: "/w", model: "m", mcpServers: [] },
  };
  assertEquals(parseEventLine(stringifyEventLine(created)), created);
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
