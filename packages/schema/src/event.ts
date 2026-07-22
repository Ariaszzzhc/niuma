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

export const SessionCreatedData = Schema.Struct({
  workspace: Schema.String,
  model: Schema.String,
});
export type SessionCreatedData = Schema.Schema.Type<typeof SessionCreatedData>;

export const SessionCreatedEvent = Schema.Struct({
  ...recordedBase,
  type: Schema.Literal("session.created"),
  data: SessionCreatedData,
});
export type SessionCreatedEvent = Schema.Schema.Type<
  typeof SessionCreatedEvent
>;

export const UserMessageData = Schema.Struct({
  parts: Schema.Array(Part),
});
export type UserMessageData = Schema.Schema.Type<typeof UserMessageData>;

export const UserMessageEvent = Schema.Struct({
  ...recordedBase,
  type: Schema.Literal("user.message"),
  data: UserMessageData,
});
export type UserMessageEvent = Schema.Schema.Type<typeof UserMessageEvent>;

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

export const ToolCallDeniedData = Schema.Struct({
  callId: Schema.String,
  reason: Schema.optional(Schema.String),
  always: Schema.optional(PermissionRule),
});
export type ToolCallDeniedData = Schema.Schema.Type<typeof ToolCallDeniedData>;

export const ToolCallDeniedEvent = Schema.Struct({
  ...recordedBase,
  type: Schema.Literal("tool.call.denied"),
  data: ToolCallDeniedData,
});
export type ToolCallDeniedEvent = Schema.Schema.Type<
  typeof ToolCallDeniedEvent
>;

export const ToolResultData = Schema.Struct({
  callId: Schema.String,
  content: ToolResultContent,
  isError: Schema.Boolean,
  durationMs: Schema.Number,
});
export type ToolResultData = Schema.Schema.Type<typeof ToolResultData>;

export const ToolResultEvent = Schema.Struct({
  ...recordedBase,
  type: Schema.Literal("tool.result"),
  data: ToolResultData,
});
export type ToolResultEvent = Schema.Schema.Type<typeof ToolResultEvent>;

export const TurnStartedData = Schema.Struct({});
export type TurnStartedData = Schema.Schema.Type<typeof TurnStartedData>;

export const TurnStartedEvent = Schema.Struct({
  ...recordedBase,
  type: Schema.Literal("turn.started"),
  data: TurnStartedData,
});
export type TurnStartedEvent = Schema.Schema.Type<typeof TurnStartedEvent>;

export const TurnCompletedData = Schema.Struct({
  stopReason: StopReason,
  usage: Usage,
});
export type TurnCompletedData = Schema.Schema.Type<typeof TurnCompletedData>;

export const TurnCompletedEvent = Schema.Struct({
  ...recordedBase,
  type: Schema.Literal("turn.completed"),
  data: TurnCompletedData,
});
export type TurnCompletedEvent = Schema.Schema.Type<typeof TurnCompletedEvent>;

export const TurnAbortedData = Schema.Struct({
  reason: Schema.String,
});
export type TurnAbortedData = Schema.Schema.Type<typeof TurnAbortedData>;

export const TurnAbortedEvent = Schema.Struct({
  ...recordedBase,
  type: Schema.Literal("turn.aborted"),
  data: TurnAbortedData,
});
export type TurnAbortedEvent = Schema.Schema.Type<typeof TurnAbortedEvent>;

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

export const ErrorOccurredData = Schema.Struct({
  message: Schema.String,
  retryable: Schema.Boolean,
});
export type ErrorOccurredData = Schema.Schema.Type<typeof ErrorOccurredData>;

export const ErrorOccurredEvent = Schema.Struct({
  ...recordedBase,
  type: Schema.Literal("error.occurred"),
  data: ErrorOccurredData,
});
export type ErrorOccurredEvent = Schema.Schema.Type<typeof ErrorOccurredEvent>;

export const RecordedEvent = Schema.Union([
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
export type RecordedEvent = Schema.Schema.Type<typeof RecordedEvent>;

export const RecordedEventType = Schema.Literals([
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
export type RecordedEventType = Schema.Schema.Type<typeof RecordedEventType>;

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

export const TextDeltaData = Schema.Struct({
  delta: Schema.String,
});
export type TextDeltaData = Schema.Schema.Type<typeof TextDeltaData>;

export const TextDeltaLive = Schema.Struct({
  ...liveBase,
  type: Schema.Literal("text.delta"),
  data: TextDeltaData,
});
export type TextDeltaLive = Schema.Schema.Type<typeof TextDeltaLive>;

export const ToolProgressData = Schema.Struct({
  callId: Schema.String,
  message: Schema.optional(Schema.String),
});
export type ToolProgressData = Schema.Schema.Type<typeof ToolProgressData>;

export const ToolProgressLive = Schema.Struct({
  ...liveBase,
  type: Schema.Literal("tool.progress"),
  data: ToolProgressData,
});
export type ToolProgressLive = Schema.Schema.Type<typeof ToolProgressLive>;

// Live-only reset signal: emitted before re-sampling after a mid-stream retry
// so clients clear their streaming text buffer. Never persisted to the JSONL
// log (no replay concerns — niuma has no client-side dedup, so we reset live).
export const TextResetLive = Schema.Struct({
  ...liveBase,
  type: Schema.Literal("text.reset"),
  data: Schema.Struct({}),
});
export type TextResetLive = Schema.Schema.Type<typeof TextResetLive>;

export const LiveEvent = Schema.Union([
  TextDeltaLive,
  ToolProgressLive,
  TextResetLive,
]);
export type LiveEvent = Schema.Schema.Type<typeof LiveEvent>;

export const LiveEventType = Schema.Literals([
  "text.delta",
  "tool.progress",
  "text.reset",
]);
export type LiveEventType = Schema.Schema.Type<typeof LiveEventType>;
