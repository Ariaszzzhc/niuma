import { assertEquals, assertThrows } from "@std/assert";
import type { RecordedEvent } from "@niuma/schema";
import {
  foldSessionState,
  InvalidSessionJournalError,
} from "../src/session_state.ts";

const base = {
  sessionId: "s1",
  ts: 1,
};

Deno.test("SessionState folds model, effort, title and lifecycle", () => {
  const events: RecordedEvent[] = [
    {
      ...base,
      seq: 1,
      type: "session.created",
      data: {
        workspace: "/tmp/work",
        model: "openai/gpt-5",
        contextWindow: 100,
        mcpServers: [],
      },
    },
    {
      ...base,
      seq: 2,
      ts: 2,
      type: "user.message",
      data: { parts: [{ type: "text", text: "  first prompt  " }] },
    },
    {
      ...base,
      seq: 3,
      ts: 3,
      type: "session.model.changed",
      data: { model: "kimi/k2", contextWindow: 200 },
    },
    {
      ...base,
      seq: 4,
      ts: 4,
      type: "session.effort.changed",
      data: { effort: "high" },
    },
    {
      ...base,
      seq: 5,
      ts: 5,
      type: "turn.started",
      data: { turnId: "t1" },
    },
    {
      ...base,
      seq: 6,
      ts: 6,
      type: "turn.completed",
      data: { turnId: "t1", stopReason: "stop" },
    },
  ];

  assertEquals(foldSessionState(events).info, {
    sessionId: "s1",
    workspace: "/tmp/work",
    model: "kimi/k2",
    effort: "high",
    contextWindow: 200,
    createdAt: 1,
    updatedAt: 6,
    status: "idle",
    lastStopReason: "stop",
    title: "first prompt",
  });
});

Deno.test("SessionState derives pending approval and active Turn", () => {
  const events: RecordedEvent[] = [
    {
      ...base,
      seq: 1,
      type: "session.created",
      data: { workspace: "/tmp/work", model: "m", mcpServers: [] },
    },
    {
      ...base,
      seq: 2,
      type: "turn.started",
      data: { turnId: "t1" },
    },
    {
      ...base,
      seq: 3,
      type: "approval.requested",
      data: { approvalId: "a1", callId: "c1", name: "bash", input: {} },
    },
  ];
  const state = foldSessionState(events);
  assertEquals(state.info.status, "waiting_approval");
  assertEquals(state.activeTurnId, "t1");
  assertEquals([...state.pendingApprovals.keys()], ["a1"]);
});

Deno.test("SessionState requires session.created first", () => {
  assertThrows(
    () =>
      foldSessionState([{
        ...base,
        seq: 1,
        type: "turn.started",
        data: { turnId: "t1" },
      }]),
    InvalidSessionJournalError,
  );
});
