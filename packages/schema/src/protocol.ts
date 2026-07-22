import { Schema } from "effect";
import { Part, StopReason } from "./domain.ts";
import { ApprovalDecisionType } from "./permission.ts";
import { LiveEvent, RecordedEvent } from "./event.ts";

// ---- Session lifecycle ----

export const CreateSessionReq = Schema.Struct({
  workspace: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
});
export type CreateSessionReq = Schema.Schema.Type<typeof CreateSessionReq>;

export const CreateSessionRes = Schema.Struct({
  sessionId: Schema.String,
  workspace: Schema.String,
  model: Schema.String,
});
export type CreateSessionRes = Schema.Schema.Type<typeof CreateSessionRes>;

export const PromptReq = Schema.Struct({
  text: Schema.String,
});
export type PromptReq = Schema.Schema.Type<typeof PromptReq>;

export const PromptRes = Schema.Struct({
  accepted: Schema.Boolean,
});
export type PromptRes = Schema.Schema.Type<typeof PromptRes>;

export const ApprovalReplyReq = Schema.Struct({
  decision: ApprovalDecisionType,
  feedback: Schema.optional(Schema.String),
});
export type ApprovalReplyReq = Schema.Schema.Type<typeof ApprovalReplyReq>;

// ---- Projection read model (SQLite-backed; rebuildable from the event log) ----

export const SessionStatus = Schema.Literals([
  "idle",
  "running",
  "waiting_approval",
  "aborted",
]);
export type SessionStatus = Schema.Schema.Type<typeof SessionStatus>;

export const SessionInfo = Schema.Struct({
  sessionId: Schema.String,
  workspace: Schema.String,
  model: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  status: SessionStatus,
  lastStopReason: Schema.optional(StopReason),
  messageCount: Schema.optional(Schema.Number),
  // First non-empty user message text (truncated); serves as the display title.
  // Populated by the projection from the first user.message event.
  title: Schema.optional(Schema.String),
});
export type SessionInfo = Schema.Schema.Type<typeof SessionInfo>;

// ---- Event reads & SSE ----

export const EventPage = Schema.Struct({
  events: Schema.Array(RecordedEvent),
  nextCursor: Schema.optional(Schema.Number),
});
export type EventPage = Schema.Schema.Type<typeof EventPage>;

// One SSE frame. `cursor` is the log seq the consumer should resume from
// (the event's own seq for recorded events, or the last applied seq for
// live-only events which have no seq of their own).
export const SseEvent = Schema.Struct({
  cursor: Schema.Number,
  event: Schema.Union([RecordedEvent, LiveEvent]),
});
export type SseEvent = Schema.Schema.Type<typeof SseEvent>;
