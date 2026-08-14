// ===========================================================================
// @niuma/tui — reduce_event table tests
// ---------------------------------------------------------------------------
// Feeds canned SSE event sequences through `reduceEvent` / `reduceEventSequence`
// and asserts on the resulting model. Pure: no terminal or native library, so
// these run standalone.
// ===========================================================================

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  _resetIds,
  initialModelState,
  reduceEvent,
  reduceEventSequence,
  type SseEvent,
} from "../src/reduce_event.ts";

const ev = (type: string, data: Record<string, unknown> = {}): SseEvent => ({
  type,
  data,
} as unknown as SseEvent);

describe("reduce_event: session + user", () => {
  it("session.created records workspace + model", () => {
    const m = reduceEventSequence([
      ev("session.created", { workspace: "/tmp/x", model: "prov/m" }),
    ]);
    assertStrictEquals(m.workspace, "/tmp/x");
    assertStrictEquals(m.model, "prov/m");
  });

  it("user.message joins text parts into a user message", () => {
    const m = reduceEventSequence([
      ev("user.message", {
        parts: [{ type: "text", text: "hello " }, {
          type: "text",
          text: "world",
        }],
      }),
    ]);
    assertStrictEquals(m.messages.length, 1);
    assertStrictEquals(m.messages[0].role, "user");
    assertStrictEquals(m.messages[0].text, "hello world");
  });

  it("user.message prefers sourceText (slash command) over expanded parts", () => {
    const m = reduceEventSequence([
      ev("user.message", {
        parts: [{ type: "text", text: "Review src/foo.ts carefully." }],
        sourceText: "/review src/foo.ts",
      }),
    ]);
    assertStrictEquals(m.messages.length, 1);
    assertStrictEquals(m.messages[0].text, "/review src/foo.ts");
  });
});

describe("reduce_event: streaming text accumulation", () => {
  it("text.delta appends into a streaming buffer", () => {
    const m = reduceEventSequence([
      ev("text.delta", { delta: "Hel" }),
      ev("text.delta", { delta: "lo" }),
    ]);
    assert(m.streaming !== null);
    assertStrictEquals(m.streaming!.text, "Hello");
    assertStrictEquals(m.messages.length, 0);
  });

  it("assistant.message finalizes the streaming buffer into a message", () => {
    const m = reduceEventSequence([
      ev("text.delta", { delta: "draft" }),
      ev("assistant.message", {
        parts: [],
      }),
    ]);
    assertStrictEquals(m.streaming, null);
    assertStrictEquals(m.messages.length, 1);
    assertStrictEquals(m.messages[0].role, "assistant");
    assertStrictEquals(m.messages[0].text, "draft");
  });

  it("assistant.message falls back to parts when there was no streaming", () => {
    const m = reduceEventSequence([
      ev("assistant.message", {
        parts: [{ type: "text", text: "from parts" }],
      }),
    ]);
    assertStrictEquals(m.messages[0].text, "from parts");
  });

  it("text.reset drops the partial buffer", () => {
    const m = reduceEventSequence([
      ev("text.delta", { delta: "partial" }),
      ev("text.reset", {}),
    ]);
    assertStrictEquals(m.streaming, null);
  });
});

describe("reduce_event: streaming thinking accumulation", () => {
  it("thinking.delta appends into a streaming buffer (independent of text)", () => {
    const m = reduceEventSequence([
      ev("thinking.delta", { delta: "Let me " }),
      ev("thinking.delta", { delta: "think…" }),
      ev("text.delta", { delta: "answer" }),
    ]);
    assert(m.streaming !== null);
    assertStrictEquals(m.streaming!.thinking, "Let me think…");
    assertStrictEquals(m.streaming!.text, "answer");
    assertStrictEquals(m.messages.length, 0);
  });

  it("thinking.delta alone seeds the streaming buffer (empty text + non-empty thinking)", () => {
    // Mirrors the text.delta-only behavior: a lone thinking.delta still
    // opens a streaming slot, and the subsequent assistant.message finalizes
    // it. Without this the reducer would drop the reasoning on the floor.
    const m = reduceEventSequence([
      ev("thinking.delta", { delta: "reasoning only" }),
      ev("assistant.message", {
        parts: [],
      }),
    ]);
    assertStrictEquals(m.streaming, null);
    assertStrictEquals(m.messages.length, 1);
    assertStrictEquals(m.messages[0].text, "");
    assertStrictEquals(m.messages[0].thinking, "reasoning only");
  });

  it("text.reset clears both text and thinking buffers", () => {
    // Re-sample after a mid-stream failure must drop the partial text AND
    // the partial reasoning together — `text.reset` is the only signal a
    // client has for "throw away the whole in-flight sample".
    const m = reduceEventSequence([
      ev("thinking.delta", { delta: "partial think" }),
      ev("text.delta", { delta: "partial text" }),
      ev("text.reset", {}),
    ]);
    assertStrictEquals(m.streaming, null);
    assertStrictEquals(m.messages.length, 0);
  });

  it("assistant.message fills TuiMessage.thinking from a ThinkingPart", () => {
    // Replay path (no live thinking.delta): the persisted parts is the only
    // source the TUI has. The thinking text must land on the message and the
    // opaque `encrypted` credential must NOT be surfaced as part of the
    // human-readable reasoning string.
    const m = reduceEventSequence([
      ev("assistant.message", {
        parts: [
          { type: "thinking", text: "let me reason", encrypted: "sig-abc123" },
          { type: "text", text: "the answer" },
        ],
      }),
    ]);
    assertStrictEquals(m.messages.length, 1);
    assertStrictEquals(m.messages[0].text, "the answer");
    assertStrictEquals(m.messages[0].thinking, "let me reason");
    assert(
      m.messages[0].thinking!.includes("sig-abc123") === false,
      "encrypted credential leaked into thinking text",
    );
  });

  it("assistant.message joins multiple ThinkingParts in order", () => {
    // kimi-style: one sample can emit multiple thinking blocks separated by
    // text or tool calls. The TUI must concatenate them in arrival order,
    // again skipping each block's `encrypted` credential.
    const m = reduceEventSequence([
      ev("assistant.message", {
        parts: [
          { type: "thinking", text: "first ", encrypted: "sig-1" },
          { type: "text", text: "bridge " },
          { type: "thinking", text: "second" },
        ],
      }),
    ]);
    assertStrictEquals(m.messages[0].thinking, "first second");
  });

  it("assistant.message with only a ThinkingPart produces a message with empty text", () => {
    // Edge case: a persisted assistant turn whose only content was reasoning
    // (e.g. a refusal expressed entirely as thinking). Still surfaces as a
    // message, just with no body text.
    const m = reduceEventSequence([
      ev("assistant.message", {
        parts: [{
          type: "thinking",
          text: "I will not comply",
          encrypted: "sig-r",
        }],
      }),
    ]);
    assertStrictEquals(m.messages.length, 1);
    assertStrictEquals(m.messages[0].text, "");
    assertStrictEquals(m.messages[0].thinking, "I will not comply");
  });
});

describe("reduce_event: tool call lifecycle", () => {
  it("derives one batch id for calls from the same assistant step", () => {
    const m = reduceEventSequence([
      ev("assistant.message", {
        parts: [
          { type: "tool_call", id: "c1", name: "read", input: {} },
          { type: "tool_call", id: "c2", name: "read", input: {} },
        ],
      }),
      ev("tool.call.requested", { callId: "c1", name: "read" }),
      ev("tool.call.requested", { callId: "c2", name: "read" }),
      ev("assistant.message", {
        parts: [{
          type: "tool_call",
          id: "c3",
          name: "read",
          input: {},
        }],
      }),
      ev("tool.call.requested", { callId: "c3", name: "read" }),
    ]);
    assertStrictEquals(m.toolCalls[0].batchId, m.toolCalls[1].batchId);
    assertStrictEquals(
      m.toolCalls[2].batchId > m.toolCalls[1].batchId,
      true,
    );
  });

  it("requested -> progress -> result", () => {
    const m = reduceEventSequence([
      ev("tool.call.requested", {
        callId: "c1",
        name: "bash",
        input: { cmd: "ls" },
      }),
      ev("tool.progress", { callId: "c1", message: "running…" }),
      ev("tool.result", {
        callId: "c1",
        content: [{ type: "text", text: "file.txt" }],
        isError: false,
        durationMs: 42,
      }),
    ]);
    assertStrictEquals(m.toolCalls.length, 1);
    const c = m.toolCalls[0];
    assertStrictEquals(c.name, "bash");
    assertStrictEquals(c.status, "done");
    assertStrictEquals(c.activity, "running…");
    assertStrictEquals(c.isError, false);
    assertStrictEquals(c.durationMs, 42);
    assertEquals([...c.resultLines], ["file.txt"]);
  });

  it("tool.result accepts a plain string content", () => {
    const m = reduceEventSequence([
      ev("tool.call.requested", { callId: "c1", name: "t" }),
      ev("tool.result", {
        callId: "c1",
        content: "a\nb",
        isError: true,
        durationMs: 1,
      }),
    ]);
    assertEquals([...m.toolCalls[0].resultLines], ["a", "b"]);
    assertStrictEquals(m.toolCalls[0].isError, true);
  });

  it("tool.call.denied marks the call denied with the reason", () => {
    const m = reduceEventSequence([
      ev("tool.call.requested", { callId: "c1", name: "t" }),
      ev("tool.call.denied", { callId: "c1", reason: "user said no" }),
    ]);
    assertStrictEquals(m.toolCalls[0].status, "denied");
    assertStrictEquals(m.toolCalls[0].activity, "user said no");
  });

  it("progress / result for an unknown callId are ignored", () => {
    const m = reduceEventSequence([
      ev("tool.call.requested", { callId: "c1", name: "t" }),
      ev("tool.progress", { callId: "nope", message: "x" }),
      ev("tool.result", {
        callId: "nope",
        content: "y",
        isError: false,
        durationMs: 0,
      }),
    ]);
    assertStrictEquals(m.toolCalls.length, 1);
    assertStrictEquals(m.toolCalls[0].status, "running");
    assertStrictEquals(m.toolCalls[0].activity, null);
  });

  it("a duplicate tool.call.requested for the same callId is a no-op", () => {
    // Replay / duplicate delivery must not double-render the card or reset a
    // finished call back to "running".
    const m = reduceEventSequence([
      ev("tool.call.requested", { callId: "c1", name: "t" }),
      ev("tool.result", {
        callId: "c1",
        content: "done",
        isError: false,
        durationMs: 3,
      }),
      ev("tool.call.requested", { callId: "c1", name: "t" }),
    ]);
    assertStrictEquals(m.toolCalls.length, 1);
    assertStrictEquals(m.toolCalls[0].status, "done");
    assertStrictEquals(m.toolCalls[0].durationMs, 3);
  });
});

describe("reduce_event: approval flow", () => {
  it("approval.requested stashes the pending approval", () => {
    const m = reduceEventSequence([
      ev("approval.requested", {
        approvalId: "ap1",
        callId: "c1",
        name: "bash",
        input: { cmd: "rm -rf" },
      }),
    ]);
    assert(m.pendingApproval !== null);
    assertStrictEquals(m.pendingApproval!.approvalId, "ap1");
    assertStrictEquals(m.pendingApproval!.toolName, "bash");
    assertStrictEquals(m.pendingApproval!.callId, "c1");
    assertEquals(m.pendingApproval!.input, { cmd: "rm -rf" });
  });

  it("approval.resolved clears the pending approval", () => {
    const m = reduceEventSequence([
      ev("approval.requested", {
        approvalId: "ap1",
        callId: "c1",
        name: "bash",
        input: {},
      }),
      ev("approval.resolved", { approvalId: "ap1", decision: "once" }),
    ]);
    assertStrictEquals(m.pendingApproval, null);
  });
});

describe("reduce_event: notices + turn state", () => {
  it("compaction.performed adds a notice and bumps the counter", () => {
    const m = reduceEventSequence([
      ev("compaction.performed", {
        mode: "llm",
        summary: "summary body",
        summaryMessageId: "summary-1",
      }),
    ]);
    assertStrictEquals(m.compactionCount, 1);
    assertStrictEquals(m.notices.length, 1);
    assertStrictEquals(m.notices[0].kind, "compaction");
    assertStrictEquals(m.notices[0].text, "context compacted (llm)");
  });

  it("error.occurred records the message and a notice", () => {
    const m = reduceEventSequence([
      ev("error.occurred", { message: "boom", retryable: false }),
    ]);
    assertStrictEquals(m.lastError, "boom");
    assertStrictEquals(m.notices[0].kind, "error");
  });

  it("turn.started marks the turn active", () => {
    const m = reduceEventSequence([
      ev("turn.started", { turnId: "turn-1" }),
    ]);
    assertStrictEquals(m.turnActive, true);
  });

  it("model.call.completed is the only source of token totals", () => {
    const m = reduceEventSequence([
      ev("model.call.completed", {
        callId: "call-1",
        turnId: "turn-1",
        purpose: "agent",
        actor: "main",
        providerId: "openai",
        modelId: "gpt-5",
        billingMode: "subscription",
        durationMs: 20,
        attempts: 1,
        finishReason: "stop",
        usage: {
          inputTokens: 120,
          outputTokens: 30,
          reasoningTokens: 10,
          cachedInputTokens: 80,
          cacheWriteTokens: null,
        },
      }),
      ev("model.call.completed", {
        callId: "call-2",
        turnId: "turn-1",
        purpose: "compaction",
        actor: "main",
        providerId: "openai",
        modelId: "gpt-5",
        billingMode: "subscription",
        durationMs: 30,
        attempts: 1,
        finishReason: "stop",
        usage: {
          inputTokens: 50,
          outputTokens: 5,
          reasoningTokens: null,
          cachedInputTokens: null,
          cacheWriteTokens: null,
        },
      }),
    ]);
    assertStrictEquals(m.tokensIn, 170);
    assertStrictEquals(m.tokensOut, 35);
    assertStrictEquals(m.lastInputTokens, 120);
  });

  it("turn.completed stops the turn and flushes streaming", () => {
    const m = reduceEventSequence([
      ev("turn.started", { turnId: "turn-1" }),
      ev("text.delta", { delta: "tail without finalize" }),
      ev("turn.completed", {
        turnId: "turn-1",
        stopReason: "stop",
      }),
    ]);
    assertStrictEquals(m.turnActive, false);
    assertStrictEquals(m.streaming, null);
    assertStrictEquals(m.lastStopReason, "stop");
    // flushed as an assistant message so the partial text is not lost
    assertStrictEquals(m.messages.length, 1);
    assertStrictEquals(m.messages[0].text, "tail without finalize");
  });

  it("turn.aborted records an abort notice + reason and stops the turn", () => {
    const m = reduceEventSequence([
      ev("turn.started", { turnId: "turn-1" }),
      ev("turn.aborted", { turnId: "turn-1", reason: "interrupted" }),
    ]);
    assertStrictEquals(m.turnActive, false);
    assertStrictEquals(m.lastStopReason, "abort");
    assertStrictEquals(m.lastError, "interrupted");
    assertStrictEquals(m.notices[m.notices.length - 1].kind, "abort");
  });
});

describe("reduce_event: end-to-end canned sequence", () => {
  it("models a full turn: prompt -> stream -> tool -> approval -> abort", () => {
    _resetIds();
    const m = reduceEventSequence([
      ev("session.created", { workspace: "/w", model: "p/m" }),
      ev("user.message", { parts: [{ type: "text", text: "run it" }] }),
      ev("turn.started", { turnId: "turn-1" }),
      ev("text.delta", { delta: "sure, " }),
      ev("text.delta", { delta: "running" }),
      ev("tool.call.requested", {
        callId: "c1",
        name: "bash",
        input: { cmd: "echo hi" },
      }),
      ev("approval.requested", {
        approvalId: "a1",
        callId: "c1",
        name: "bash",
        input: { cmd: "echo hi" },
      }),
      // assistant.message finalizes the streamed text BEFORE the tool result
      ev("assistant.message", {
        parts: [],
      }),
      ev("approval.resolved", { approvalId: "a1", decision: "once" }),
      ev("tool.result", {
        callId: "c1",
        content: "hi",
        isError: false,
        durationMs: 5,
      }),
      ev("turn.aborted", {
        turnId: "turn-1",
        reason: "user interrupt",
      }),
    ]);

    // messages: user + finalized assistant
    assertStrictEquals(m.messages.length, 2);
    assertStrictEquals(m.messages[0].role, "user");
    assertStrictEquals(m.messages[1].role, "assistant");
    assertStrictEquals(m.messages[1].text, "sure, running");

    // tool lifecycle
    assertStrictEquals(m.toolCalls[0].status, "done");
    assertEquals([...m.toolCalls[0].resultLines], ["hi"]);

    // approval cleared, turn inactive, abort noticed
    assertStrictEquals(m.pendingApproval, null);
    assertStrictEquals(m.turnActive, false);
    assertStrictEquals(m.lastStopReason, "abort");
  });
});

describe("reduce_event: purity", () => {
  it("does not mutate the input model", () => {
    const start = initialModelState();
    const snap = JSON.stringify(start);
    reduceEvent(start, ev("text.delta", { delta: "x" }));
    assertStrictEquals(JSON.stringify(start), snap);
  });
});

describe("reduce_event: subagent lifecycle", () => {
  it("subagent.spawned attaches channel info to the spawn_subagent card by callId", () => {
    let model = reduceEvent(
      initialModelState(),
      ev("tool.call.requested", {
        callId: "c1",
        name: "spawn_subagent",
        input: { prompt: "p" },
      }),
    );
    model = reduceEvent(
      model,
      ev("subagent.spawned", {
        parentSessionId: "main",
        childSessionId: "child-1",
        prompt: "p",
        callId: "c1",
      }),
    );
    assertEquals(model.toolCalls[0].subagent, {
      childSessionId: "child-1",
      prompt: "p",
      status: "running",
      durationMs: 0,
      tokensIn: null,
      tokensOut: null,
    });
  });

  it("subagent.completed flips the card badge and fills usage", () => {
    let model = reduceEvent(
      initialModelState(),
      ev("tool.call.requested", {
        callId: "c1",
        name: "spawn_subagent",
        input: { prompt: "p" },
      }),
    );
    model = reduceEvent(
      model,
      ev("subagent.spawned", {
        parentSessionId: "main",
        childSessionId: "child-1",
        prompt: "p",
        callId: "c1",
      }),
    );
    model = reduceEvent(
      model,
      ev("subagent.completed", {
        parentSessionId: "main",
        childSessionId: "child-1",
        callId: "c1",
        ok: false,
        usage: { inputTokens: 12, outputTokens: 3 },
        durationMs: 900,
      }),
    );
    assertEquals(model.toolCalls[0].subagent, {
      childSessionId: "child-1",
      prompt: "p",
      status: "failed",
      durationMs: 900,
      tokensIn: 12,
      tokensOut: 3,
    });
  });

  it("subagent.completed with unknown childSessionId is a no-op", () => {
    const start = initialModelState();
    const model = reduceEvent(
      start,
      ev("subagent.completed", {
        parentSessionId: "main",
        childSessionId: "ghost",
        ok: true,
        usage: null,
        durationMs: 1,
      }),
    );
    assertStrictEquals(model, start);
  });
});
