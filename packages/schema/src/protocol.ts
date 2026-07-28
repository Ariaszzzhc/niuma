import { Schema } from "effect";
import { StopReason } from "./domain.ts";
import { ApprovalDecisionType } from "./permission.ts";
import { LiveEvent, McpServerStatus, RecordedEvent } from "./event.ts";

// ---- Server-owned client configuration ----

// How a prompt submitted while a turn is already active is admitted by the
// server. This is server configuration: clients request changes and consume
// the authoritative view returned by the server.
// deno-lint-ignore no-slow-types
const InputDelivery_ = Schema.Literals(["steer", "queue"]);
export type InputDelivery = Schema.Schema.Type<typeof InputDelivery_>;
export const InputDelivery: Schema.Codec<InputDelivery> = InputDelivery_;

// Sanitized configuration projected to clients. Provider definitions,
// credentials, filesystem paths, and other server-only settings never cross
// this wire seam.
// deno-lint-ignore no-slow-types
const ClientConfigView_ = Schema.Struct({
  inputDelivery: InputDelivery_,
});
export type ClientConfigView = Schema.Schema.Type<typeof ClientConfigView_>;
export const ClientConfigView: Schema.Codec<ClientConfigView> =
  ClientConfigView_;

// deno-lint-ignore no-slow-types
const SetInputDeliveryReq_ = Schema.Struct({
  inputDelivery: InputDelivery_,
});
export type SetInputDeliveryReq = Schema.Schema.Type<
  typeof SetInputDeliveryReq_
>;
export const SetInputDeliveryReq: Schema.Codec<SetInputDeliveryReq> =
  SetInputDeliveryReq_;

// deno-lint-ignore no-slow-types
const SetInputDeliveryRes_ = Schema.Struct({
  ok: Schema.Literal(true),
  config: ClientConfigView_,
});
export type SetInputDeliveryRes = Schema.Schema.Type<
  typeof SetInputDeliveryRes_
>;
export const SetInputDeliveryRes: Schema.Codec<SetInputDeliveryRes> =
  SetInputDeliveryRes_;

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
  // Server-digested settings relevant to the client.
  clientConfig: ClientConfigView_,
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
  disposition: Schema.Literals(["started", "steered", "queued"]),
});
export type PromptRes = Schema.Schema.Type<typeof PromptRes_>;
export const PromptRes: Schema.Codec<PromptRes> = PromptRes_;

// User input accepted into a turn but not yet consumed by the agent. Explicit
// interrupt and terminal turn failure return these as independent drafts.
// deno-lint-ignore no-slow-types
const ReturnedInput_ = Schema.Struct({
  sourceText: Schema.String,
});
export type ReturnedInput = Schema.Schema.Type<typeof ReturnedInput_>;
export const ReturnedInput: Schema.Codec<ReturnedInput> = ReturnedInput_;

// deno-lint-ignore no-slow-types
const InterruptRes_ = Schema.Struct({
  ok: Schema.Literal(true),
  returnedInputs: Schema.Array(ReturnedInput_),
});
export type InterruptRes = Schema.Schema.Type<typeof InterruptRes_>;
export const InterruptRes: Schema.Codec<InterruptRes> = InterruptRes_;

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

// ---- Session State read model (folded from one Session Journal) ----

// deno-lint-ignore no-slow-types
const SessionStatus_ = Schema.Literals([
  "idle",
  "running",
  "waiting_approval",
]);
export type SessionStatus = Schema.Schema.Type<typeof SessionStatus_>;
export const SessionStatus: Schema.Codec<SessionStatus> = SessionStatus_;

// deno-lint-ignore no-slow-types
const SessionInfo_ = Schema.Struct({
  sessionId: Schema.String,
  workspace: Schema.String,
  model: Schema.String,
  effort: Schema.optional(Schema.String),
  contextWindow: Schema.optional(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  status: SessionStatus,
  lastStopReason: Schema.optional(StopReason),
  // First non-empty user message text (truncated); serves as the display title.
  // Derived from the first user.message event.
  title: Schema.optional(Schema.String),
});
export type SessionInfo = Schema.Schema.Type<typeof SessionInfo_>;
export const SessionInfo: Schema.Codec<SessionInfo> = SessionInfo_;

export const SessionListRes = Schema.Array(SessionInfo_);
export type SessionListRes = Schema.Schema.Type<typeof SessionListRes>;

// Filename-only Session ids for exact/unique-prefix `/resume` resolution.
// Unlike SessionListRes this does not open or fold every Journal.
export const SessionIdListRes = Schema.Array(Schema.String);
export type SessionIdListRes = Schema.Schema.Type<typeof SessionIdListRes>;

export const GetSessionRes = Schema.Struct({
  info: SessionInfo_,
  history: Schema.Array(RecordedEvent),
  contextWindow: Schema.optional(Schema.Number),
  mcpServers: Schema.Array(McpServerStatus),
  commands: Schema.Array(CommandInfo_),
  clientConfig: ClientConfigView_,
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
