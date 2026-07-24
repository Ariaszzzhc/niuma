import { Schema } from "effect";
import { Part, StopReason, ToolResultContent, Usage } from "./domain.ts";
import { ApprovalDecisionType, PermissionRule } from "./permission.ts";

// ============================================================================
// Recorded events — appended to the per-session JSONL event log (source of
// truth). Each variant is a full envelope: { seq, ts, sessionId, type, data }.
// The union is discriminated on `type`; `data` carries the type-specific
// payload. Empty payloads use `Schema.Struct({})`.
// ============================================================================

const recordedBase = {
  seq: Schema.Number,
  ts: Schema.Number,
  sessionId: Schema.String,
};

// deno-lint-ignore no-slow-types
const SessionCreatedData_ = Schema.Struct({
  workspace: Schema.String,
  model: Schema.String,
});
export type SessionCreatedData = Schema.Schema.Type<typeof SessionCreatedData_>;
export const SessionCreatedData: Schema.Codec<SessionCreatedData> =
  SessionCreatedData_;

export const SessionCreatedEvent = Schema.Struct({
  ...recordedBase,
  type: Schema.Literal("session.created"),
  data: SessionCreatedData,
});
export type SessionCreatedEvent = Schema.Schema.Type<
  typeof SessionCreatedEvent
>;

// deno-lint-ignore no-slow-types
const UserMessageData_ = Schema.Struct({
  parts: Schema.Array(Part),
});
export type UserMessageData = Schema.Schema.Type<typeof UserMessageData_>;
export const UserMessageData: Schema.Codec<UserMessageData> = UserMessageData_;

// deno-lint-ignore no-slow-types
const UserMessageEvent_ = Schema.Struct({
  ...recordedBase,
  type: Schema.Literal("user.message"),
  data: UserMessageData,
});
export type UserMessageEvent = Schema.Schema.Type<typeof UserMessageEvent_>;
export const UserMessageEvent: Schema.Codec<UserMessageEvent> =
  UserMessageEvent_;

export const AssistantMessageData = Schema.Struct({
  parts: Schema.Array(Part),
  usage: Usage,
});
export type AssistantMessageData = Schema.Schema.Type<
  typeof AssistantMessageData
>;

export const AssistantMessageEvent = Schema.Struct({
  ...recordedBase,
  type: Schema.Literal("assistant.message"),
  data: AssistantMessageData,
});
export type AssistantMessageEvent = Schema.Schema.Type<
  typeof AssistantMessageEvent
>;

export const ToolCallRequestedData = Schema.Struct({
  callId: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
});
export type ToolCallRequestedData = Schema.Schema.Type<
  typeof ToolCallRequestedData
>;

export const ToolCallRequestedEvent = Schema.Struct({
  ...recordedBase,
  type: Schema.Literal("tool.call.requested"),
  data: ToolCallRequestedData,
});
export type ToolCallRequestedEvent = Schema.Schema.Type<
  typeof ToolCallRequestedEvent
>;

// `always` records the synthesized rule when an approval resolves to "always".
export const ToolCallApprovedData = Schema.Struct({
  callId: Schema.String,
  reason: Schema.optional(Schema.String),
  always: Schema.optional(PermissionRule),
});
export type ToolCallApprovedData = Schema.Schema.Type<
  typeof ToolCallApprovedData
>;

export const ToolCallApprovedEvent = Schema.Struct({
  ...recordedBase,
  type: Schema.Literal("tool.call.approved"),
  data: ToolCallApprovedData,
});
export type ToolCallApprovedEvent = Schema.Schema.Type<
  typeof ToolCallApprovedEvent
>;

// deno-lint-ignore no-slow-types
const ToolCallDeniedData_ = Schema.Struct({
  callId: Schema.String,
  reason: Schema.optional(Schema.String),
  always: Schema.optional(PermissionRule),
});
export type ToolCallDeniedData = Schema.Schema.Type<typeof ToolCallDeniedData_>;
export const ToolCallDeniedData: Schema.Codec<ToolCallDeniedData> =
  ToolCallDeniedData_;

export const ToolCallDeniedEvent = Schema.Struct({
  ...recordedBase,
  type: Schema.Literal("tool.call.denied"),
  data: ToolCallDeniedData,
});
export type ToolCallDeniedEvent = Schema.Schema.Type<
  typeof ToolCallDeniedEvent
>;

// deno-lint-ignore no-slow-types
const ToolResultData_ = Schema.Struct({
  callId: Schema.String,
  content: ToolResultContent,
  isError: Schema.Boolean,
  durationMs: Schema.Number,
});
export type ToolResultData = Schema.Schema.Type<typeof ToolResultData_>;
export const ToolResultData: Schema.Codec<ToolResultData> = ToolResultData_;

// deno-lint-ignore no-slow-types
const ToolResultEvent_ = Schema.Struct({
  ...recordedBase,
  type: Schema.Literal("tool.result"),
  data: ToolResultData,
});
export type ToolResultEvent = Schema.Schema.Type<typeof ToolResultEvent_>;
export const ToolResultEvent: Schema.Codec<ToolResultEvent> = ToolResultEvent_;

// deno-lint-ignore no-slow-types
const TurnStartedData_ = Schema.Struct({});
export type TurnStartedData = Schema.Schema.Type<typeof TurnStartedData_>;
export const TurnStartedData: Schema.Codec<TurnStartedData> = TurnStartedData_;

// deno-lint-ignore no-slow-types
const TurnStartedEvent_ = Schema.Struct({
  ...recordedBase,
  type: Schema.Literal("turn.started"),
  data: TurnStartedData,
});
export type TurnStartedEvent = Schema.Schema.Type<typeof TurnStartedEvent_>;
export const TurnStartedEvent: Schema.Codec<TurnStartedEvent> =
  TurnStartedEvent_;

// deno-lint-ignore no-slow-types
const TurnCompletedData_ = Schema.Struct({
  stopReason: StopReason,
  usage: Usage,
});
export type TurnCompletedData = Schema.Schema.Type<typeof TurnCompletedData_>;
export const TurnCompletedData: Schema.Codec<TurnCompletedData> =
  TurnCompletedData_;

// deno-lint-ignore no-slow-types
const TurnCompletedEvent_ = Schema.Struct({
  ...recordedBase,
  type: Schema.Literal("turn.completed"),
  data: TurnCompletedData,
});
export type TurnCompletedEvent = Schema.Schema.Type<typeof TurnCompletedEvent_>;
export const TurnCompletedEvent: Schema.Codec<TurnCompletedEvent> =
  TurnCompletedEvent_;

// deno-lint-ignore no-slow-types
const TurnAbortedData_ = Schema.Struct({
  reason: Schema.String,
});
export type TurnAbortedData = Schema.Schema.Type<typeof TurnAbortedData_>;
export const TurnAbortedData: Schema.Codec<TurnAbortedData> = TurnAbortedData_;

// deno-lint-ignore no-slow-types
const TurnAbortedEvent_ = Schema.Struct({
  ...recordedBase,
  type: Schema.Literal("turn.aborted"),
  data: TurnAbortedData,
});
export type TurnAbortedEvent = Schema.Schema.Type<typeof TurnAbortedEvent_>;
export const TurnAbortedEvent: Schema.Codec<TurnAbortedEvent> =
  TurnAbortedEvent_;

export const CompactionPerformedData = Schema.Struct({
  summaryMessageId: Schema.optional(Schema.String),
  // "llm" = model-generated handoff summary (the summarizer call succeeded
  // and returned non-empty text); "template" = deterministic fallback used
  // when the summary call failed or returned empty. Optional → old JSONL
  // logs decode unchanged.
  mode: Schema.optional(Schema.Literals(["llm", "template"])),
});
export type CompactionPerformedData = Schema.Schema.Type<
  typeof CompactionPerformedData
>;

export const CompactionPerformedEvent = Schema.Struct({
  ...recordedBase,
  type: Schema.Literal("compaction.performed"),
  data: CompactionPerformedData,
});
export type CompactionPerformedEvent = Schema.Schema.Type<
  typeof CompactionPerformedEvent
>;

export const ApprovalRequestedData = Schema.Struct({
  approvalId: Schema.String,
  callId: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
});
export type ApprovalRequestedData = Schema.Schema.Type<
  typeof ApprovalRequestedData
>;

// Live-routed to the frontend but also persisted to the log so a reconnect or
// resume can reconstruct pending approvals.
export const ApprovalRequestedEvent = Schema.Struct({
  ...recordedBase,
  type: Schema.Literal("approval.requested"),
  data: ApprovalRequestedData,
});
export type ApprovalRequestedEvent = Schema.Schema.Type<
  typeof ApprovalRequestedEvent
>;

export const ApprovalResolvedData = Schema.Struct({
  approvalId: Schema.String,
  decision: ApprovalDecisionType,
  feedback: Schema.optional(Schema.String),
});
export type ApprovalResolvedData = Schema.Schema.Type<
  typeof ApprovalResolvedData
>;

export const ApprovalResolvedEvent = Schema.Struct({
  ...recordedBase,
  type: Schema.Literal("approval.resolved"),
  data: ApprovalResolvedData,
});
export type ApprovalResolvedEvent = Schema.Schema.Type<
  typeof ApprovalResolvedEvent
>;

export const SubagentSpawnedData = Schema.Struct({
  parentSessionId: Schema.String,
  childSessionId: Schema.String,
  prompt: Schema.String,
});
export type SubagentSpawnedData = Schema.Schema.Type<
  typeof SubagentSpawnedData
>;

export const SubagentSpawnedEvent = Schema.Struct({
  ...recordedBase,
  type: Schema.Literal("subagent.spawned"),
  data: SubagentSpawnedData,
});
export type SubagentSpawnedEvent = Schema.Schema.Type<
  typeof SubagentSpawnedEvent
>;

// deno-lint-ignore no-slow-types
const ErrorOccurredData_ = Schema.Struct({
  message: Schema.String,
  retryable: Schema.Boolean,
});
export type ErrorOccurredData = Schema.Schema.Type<typeof ErrorOccurredData_>;
export const ErrorOccurredData: Schema.Codec<ErrorOccurredData> =
  ErrorOccurredData_;

// deno-lint-ignore no-slow-types
const ErrorOccurredEvent_ = Schema.Struct({
  ...recordedBase,
  type: Schema.Literal("error.occurred"),
  data: ErrorOccurredData,
});
export type ErrorOccurredEvent = Schema.Schema.Type<typeof ErrorOccurredEvent_>;
export const ErrorOccurredEvent: Schema.Codec<ErrorOccurredEvent> =
  ErrorOccurredEvent_;

// deno-lint-ignore no-slow-types
const RecordedEvent_ = Schema.Union([
  SessionCreatedEvent,
  UserMessageEvent,
  AssistantMessageEvent,
  ToolCallRequestedEvent,
  ToolCallApprovedEvent,
  ToolCallDeniedEvent,
  ToolResultEvent,
  TurnStartedEvent,
  TurnCompletedEvent,
  TurnAbortedEvent,
  CompactionPerformedEvent,
  ApprovalRequestedEvent,
  ApprovalResolvedEvent,
  SubagentSpawnedEvent,
  ErrorOccurredEvent,
]);
export type RecordedEvent = Schema.Schema.Type<typeof RecordedEvent_>;
export const RecordedEvent: Schema.Codec<RecordedEvent> = RecordedEvent_;

// deno-lint-ignore no-slow-types
const RecordedEventType_ = Schema.Literals([
  "session.created",
  "user.message",
  "assistant.message",
  "tool.call.requested",
  "tool.call.approved",
  "tool.call.denied",
  "tool.result",
  "turn.started",
  "turn.completed",
  "turn.aborted",
  "compaction.performed",
  "approval.requested",
  "approval.resolved",
  "subagent.spawned",
  "error.occurred",
]);
export type RecordedEventType = Schema.Schema.Type<typeof RecordedEventType_>;
export const RecordedEventType: Schema.Codec<RecordedEventType> =
  RecordedEventType_;

// Alias: every recorded event is an envelope. Generic helpers can use this.
export type EventEnvelope = RecordedEvent;

// ============================================================================
// Live-only events — streamed over SSE, never appended to the JSONL log.
// Envelope shape mirrors recorded events minus `seq`; the SSE frame supplies
// the cursor.
// ============================================================================

const liveBase = {
  ts: Schema.Number,
  sessionId: Schema.String,
};

// deno-lint-ignore no-slow-types
const ThinkingDeltaData_ = Schema.Struct({
  delta: Schema.String,
});
export type ThinkingDeltaData = Schema.Schema.Type<typeof ThinkingDeltaData_>;
export const ThinkingDeltaData: Schema.Codec<ThinkingDeltaData> =
  ThinkingDeltaData_;

// deno-lint-ignore no-slow-types
const ThinkingDeltaLive_ = Schema.Struct({
  ...liveBase,
  type: Schema.Literal("thinking.delta"),
  data: ThinkingDeltaData,
});
export type ThinkingDeltaLive = Schema.Schema.Type<typeof ThinkingDeltaLive_>;
export const ThinkingDeltaLive: Schema.Codec<ThinkingDeltaLive> =
  ThinkingDeltaLive_;

// deno-lint-ignore no-slow-types
const TextDeltaData_ = Schema.Struct({
  delta: Schema.String,
});
export type TextDeltaData = Schema.Schema.Type<typeof TextDeltaData_>;
export const TextDeltaData: Schema.Codec<TextDeltaData> = TextDeltaData_;

// deno-lint-ignore no-slow-types
const TextDeltaLive_ = Schema.Struct({
  ...liveBase,
  type: Schema.Literal("text.delta"),
  data: TextDeltaData,
});
export type TextDeltaLive = Schema.Schema.Type<typeof TextDeltaLive_>;
export const TextDeltaLive: Schema.Codec<TextDeltaLive> = TextDeltaLive_;

// deno-lint-ignore no-slow-types
const ToolProgressData_ = Schema.Struct({
  callId: Schema.String,
  message: Schema.optional(Schema.String),
});
export type ToolProgressData = Schema.Schema.Type<typeof ToolProgressData_>;
export const ToolProgressData: Schema.Codec<ToolProgressData> =
  ToolProgressData_;

// deno-lint-ignore no-slow-types
const ToolProgressLive_ = Schema.Struct({
  ...liveBase,
  type: Schema.Literal("tool.progress"),
  data: ToolProgressData,
});
export type ToolProgressLive = Schema.Schema.Type<typeof ToolProgressLive_>;
export const ToolProgressLive: Schema.Codec<ToolProgressLive> =
  ToolProgressLive_;

// Live-only reset signal: emitted before re-sampling after a mid-stream retry
// so clients clear their streaming text buffer. Never persisted to the JSONL
// log (no replay concerns — niuma has no client-side dedup, so we reset live).
// deno-lint-ignore no-slow-types
const TextResetLive_ = Schema.Struct({
  ...liveBase,
  type: Schema.Literal("text.reset"),
  data: Schema.Struct({}),
});
export type TextResetLive = Schema.Schema.Type<typeof TextResetLive_>;
export const TextResetLive: Schema.Codec<TextResetLive> = TextResetLive_;

// deno-lint-ignore no-slow-types
const LiveEvent_ = Schema.Union([
  ThinkingDeltaLive,
  TextDeltaLive,
  ToolProgressLive,
  TextResetLive,
]);
export type LiveEvent = Schema.Schema.Type<typeof LiveEvent_>;
export const LiveEvent: Schema.Codec<LiveEvent> = LiveEvent_;

// deno-lint-ignore no-slow-types
const LiveEventType_ = Schema.Literals([
  "thinking.delta",
  "text.delta",
  "tool.progress",
  "text.reset",
]);
export type LiveEventType = Schema.Schema.Type<typeof LiveEventType_>;
export const LiveEventType: Schema.Codec<LiveEventType> = LiveEventType_;
