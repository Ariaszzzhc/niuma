// ===========================================================================
// @niuma/tui — reduce_event table tests
// ---------------------------------------------------------------------------
// Feeds canned SSE event sequences through `reduceEvent` / `reduceEventSequence`
// and asserts on the resulting model. Pure: no terminal, no native lib, no
// A-side imports — so these run standalone.
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
});

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
        usage: { inputTokens: 0, outputTokens: 0 },
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

describe("reduce_event: tool call lifecycle", () => {
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
      ev("compaction.performed", { mode: "llm" }),
    ]);
    assertStrictEquals(m.compactionCount, 1);
    assertStrictEquals(m.notices.length, 1);
    assertStrictEquals(m.notices[0].kind, "compaction");
  });

  it("error.occurred records the message and a notice", () => {
    const m = reduceEventSequence([
      ev("error.occurred", { message: "boom", retryable: false }),
    ]);
    assertStrictEquals(m.lastError, "boom");
    assertStrictEquals(m.notices[0].kind, "error");
  });

  it("turn.started marks the turn active", () => {
    const m = reduceEventSequence([ev("turn.started", {})]);
    assertStrictEquals(m.turnActive, true);
  });

  it("turn.completed stops the turn and flushes streaming", () => {
    const m = reduceEventSequence([
      ev("turn.started", {}),
      ev("text.delta", { delta: "tail without finalize" }),
      ev("turn.completed", {
        stopReason: "stop",
        usage: { inputTokens: 1, outputTokens: 2 },
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
      ev("turn.started", {}),
      ev("turn.aborted", { reason: "interrupted" }),
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
      ev("turn.started", {}),
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
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
      ev("approval.resolved", { approvalId: "a1", decision: "once" }),
      ev("tool.result", {
        callId: "c1",
        content: "hi",
        isError: false,
        durationMs: 5,
      }),
      ev("turn.aborted", { reason: "user interrupt" }),
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

describe("reduce_event: purity + unknown events", () => {
  it("does not mutate the input model", () => {
    const start = initialModelState();
    const snap = JSON.stringify(start);
    reduceEvent(start, ev("text.delta", { delta: "x" }));
    assertStrictEquals(JSON.stringify(start), snap);
  });

  it("unknown event types are a no-op", () => {
    const start = initialModelState();
    const m = reduceEvent(start, ev("some.future.event", { x: 1 }));
    assertStrictEquals(m, start);
  });
});
