import { Schema } from "effect";
import { StopReason } from "./domain.ts";
import { ApprovalDecisionType } from "./permission.ts";
import { LiveEvent, RecordedEvent } from "./event.ts";

// ---- Session lifecycle ----

// deno-lint-ignore no-slow-types
const CreateSessionReq_ = Schema.Struct({
  workspace: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
});
export type CreateSessionReq = Schema.Schema.Type<typeof CreateSessionReq_>;
export const CreateSessionReq: Schema.Codec<CreateSessionReq> =
  CreateSessionReq_;

// deno-lint-ignore no-slow-types
const CreateSessionRes_ = Schema.Struct({
  sessionId: Schema.String,
  workspace: Schema.String,
  model: Schema.String,
});
export type CreateSessionRes = Schema.Schema.Type<typeof CreateSessionRes_>;
export const CreateSessionRes: Schema.Codec<CreateSessionRes> =
  CreateSessionRes_;

// deno-lint-ignore no-slow-types
const PromptReq_ = Schema.Struct({
  text: Schema.String,
});
export type PromptReq = Schema.Schema.Type<typeof PromptReq_>;
export const PromptReq: Schema.Codec<PromptReq> = PromptReq_;

// deno-lint-ignore no-slow-types
const PromptRes_ = Schema.Struct({
  accepted: Schema.Boolean,
});
export type PromptRes = Schema.Schema.Type<typeof PromptRes_>;
export const PromptRes: Schema.Codec<PromptRes> = PromptRes_;

// deno-lint-ignore no-slow-types
const ApprovalReplyReq_ = Schema.Struct({
  decision: ApprovalDecisionType,
  feedback: Schema.optional(Schema.String),
});
export type ApprovalReplyReq = Schema.Schema.Type<typeof ApprovalReplyReq_>;
export const ApprovalReplyReq: Schema.Codec<ApprovalReplyReq> =
  ApprovalReplyReq_;

// ---- Projection read model (SQLite-backed; rebuildable from the event log) ----

// deno-lint-ignore no-slow-types
const SessionStatus_ = Schema.Literals([
  "idle",
  "running",
  "waiting_approval",
  "aborted",
]);
export type SessionStatus = Schema.Schema.Type<typeof SessionStatus_>;
export const SessionStatus: Schema.Codec<SessionStatus> = SessionStatus_;

// deno-lint-ignore no-slow-types
const SessionInfo_ = Schema.Struct({
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
export type SessionInfo = Schema.Schema.Type<typeof SessionInfo_>;
export const SessionInfo: Schema.Codec<SessionInfo> = SessionInfo_;

// ---- Event reads & SSE ----

// deno-lint-ignore no-slow-types
const EventPage_ = Schema.Struct({
  events: Schema.Array(RecordedEvent),
  nextCursor: Schema.optional(Schema.Number),
});
export type EventPage = Schema.Schema.Type<typeof EventPage_>;
export const EventPage: Schema.Codec<EventPage> = EventPage_;

// One SSE frame. `cursor` is the log seq the consumer should resume from
// (the event's own seq for recorded events, or the last applied seq for
// live-only events which have no seq of their own).
// deno-lint-ignore no-slow-types
const SseEvent_ = Schema.Struct({
  cursor: Schema.Number,
  event: Schema.Union([RecordedEvent, LiveEvent]),
});
export type SseEvent = Schema.Schema.Type<typeof SseEvent_>;
export const SseEvent: Schema.Codec<SseEvent> = SseEvent_;
