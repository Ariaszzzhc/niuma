import { Schema } from "effect";
import { StopReason } from "./domain.ts";
import { ApprovalDecisionType } from "./permission.ts";
import { LiveEvent, McpServerStatus, RecordedEvent } from "./event.ts";

// ---- Custom slash commands ----

// A user/project-defined command (a `commands/*.md` template), as listed in
// the session-create response. `template` stays server-side; clients only
// need the listing metadata.
// deno-lint-ignore no-slow-types
const CommandInfo_ = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  argumentHint: Schema.optional(Schema.String),
});
export type CommandInfo = Schema.Schema.Type<typeof CommandInfo_>;
export const CommandInfo: Schema.Codec<CommandInfo> = CommandInfo_;

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
  contextWindow: Schema.optional(Schema.Number),
  mcpServers: Schema.Array(McpServerStatus),
  // Custom slash commands visible to this session's workspace.
  commands: Schema.Array(CommandInfo_),
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
  accepted: Schema.Literal(true),
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

// ---- Runtime model / effort switching ----

// `model` accepts either a full "provider/model-id" ref (a cross-provider
// switch rebuilds the adapter server-side) or a bare model-id (same provider,
// new model name).
// deno-lint-ignore no-slow-types
const SetModelReq_ = Schema.Struct({
  model: Schema.String,
});
export type SetModelReq = Schema.Schema.Type<typeof SetModelReq_>;
export const SetModelReq: Schema.Codec<SetModelReq> = SetModelReq_;

// deno-lint-ignore no-slow-types
const SetModelRes_ = Schema.Struct({
  ok: Schema.Literal(true),
  model: Schema.String,
  contextWindow: Schema.optional(Schema.Number),
});
export type SetModelRes = Schema.Schema.Type<typeof SetModelRes_>;
export const SetModelRes: Schema.Codec<SetModelRes> = SetModelRes_;

// `effort` is a provider-defined档位 string passed through verbatim — no
// enum validation (mirrors ThinkingConfig.effort).
// deno-lint-ignore no-slow-types
const SetEffortReq_ = Schema.Struct({
  effort: Schema.String,
});
export type SetEffortReq = Schema.Schema.Type<typeof SetEffortReq_>;
export const SetEffortReq: Schema.Codec<SetEffortReq> = SetEffortReq_;

// deno-lint-ignore no-slow-types
const SetEffortRes_ = Schema.Struct({
  ok: Schema.Literal(true),
  effort: Schema.String,
});
export type SetEffortRes = Schema.Schema.Type<typeof SetEffortRes_>;
export const SetEffortRes: Schema.Codec<SetEffortRes> = SetEffortRes_;

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
  // First non-empty user message text (truncated); serves as the display title.
  // Populated by the projection from the first user.message event.
  title: Schema.optional(Schema.String),
});
export type SessionInfo = Schema.Schema.Type<typeof SessionInfo_>;
export const SessionInfo: Schema.Codec<SessionInfo> = SessionInfo_;

export const SessionListRes = Schema.Array(SessionInfo_);
export type SessionListRes = Schema.Schema.Type<typeof SessionListRes>;

export const GetSessionRes = Schema.Struct({
  info: SessionInfo_,
  history: Schema.Array(RecordedEvent),
  contextWindow: Schema.optional(Schema.Number),
  mcpServers: Schema.Array(McpServerStatus),
  commands: Schema.Array(CommandInfo_),
});
export type GetSessionRes = Schema.Schema.Type<typeof GetSessionRes>;

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
