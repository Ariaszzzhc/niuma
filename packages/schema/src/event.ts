import { Schema } from "effect";
import { Part, StopReason, ToolResultContent, Usage } from "./domain.ts";
import { ApprovalDecisionType, PermissionRule } from "./permission.ts";

// ============================================================================
// Recorded events — appended to the per-Session JSONL Journal (source of
// truth). Each variant is a full envelope: { seq, ts, sessionId, type, data }.
// The union is discriminated on `type`; `data` carries the type-specific
// payload. Empty payloads use `Schema.Struct({})`.
// ============================================================================

const recordedBase = {
  seq: Schema.Number,
  ts: Schema.Number,
  sessionId: Schema.String,
};

// `contextWindow` is the resolved window for the session's model (the status
// line shows context usage against it); absent when the server cannot resolve
// one (injected test infra). `mcpServers` is the final list of MCP servers that
// came up at boot, including the empty-list case.
const McpServerStatus_ = Schema.Struct({
  id: Schema.String,
  toolCount: Schema.Number,
});
export type McpServerStatus = Schema.Schema.Type<typeof McpServerStatus_>;
export const McpServerStatus: Schema.Codec<McpServerStatus> = McpServerStatus_;

// deno-lint-ignore no-slow-types
const SessionCreatedData_ = Schema.Struct({
  workspace: Schema.String,
  model: Schema.String,
  effort: Schema.optional(Schema.String),
  contextWindow: Schema.optional(Schema.Number),
  mcpServers: Schema.Array(McpServerStatus_),
  // Set only on child sessions spawned via spawn_subagent; top-level sessions
  // omit it. Session listing filters on its presence.
  parentSessionId: Schema.optional(Schema.String),
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
const SessionModelChangedData_ = Schema.Struct({
  model: Schema.String,
  contextWindow: Schema.optional(Schema.Number),
});
export type SessionModelChangedData = Schema.Schema.Type<
  typeof SessionModelChangedData_
>;
export const SessionModelChangedData: Schema.Codec<SessionModelChangedData> =
  SessionModelChangedData_;

export const SessionModelChangedEvent = Schema.Struct({
  ...recordedBase,
  type: Schema.Literal("session.model.changed"),
  data: SessionModelChangedData,
});
export type SessionModelChangedEvent = Schema.Schema.Type<
  typeof SessionModelChangedEvent
>;

// deno-lint-ignore no-slow-types
const SessionEffortChangedData_ = Schema.Struct({
  effort: Schema.String,
});
export type SessionEffortChangedData = Schema.Schema.Type<
  typeof SessionEffortChangedData_
>;
export const SessionEffortChangedData: Schema.Codec<SessionEffortChangedData> =
  SessionEffortChangedData_;

export const SessionEffortChangedEvent = Schema.Struct({
  ...recordedBase,
  type: Schema.Literal("session.effort.changed"),
  data: SessionEffortChangedData,
});
export type SessionEffortChangedEvent = Schema.Schema.Type<
  typeof SessionEffortChangedEvent
>;

// deno-lint-ignore no-slow-types
const SessionTitleChangedData_ = Schema.Struct({
  title: Schema.String,
});
export type SessionTitleChangedData = Schema.Schema.Type<
  typeof SessionTitleChangedData_
>;
export const SessionTitleChangedData: Schema.Codec<SessionTitleChangedData> =
  SessionTitleChangedData_;

export const SessionTitleChangedEvent = Schema.Struct({
  ...recordedBase,
  type: Schema.Literal("session.title.changed"),
  data: SessionTitleChangedData,
});
export type SessionTitleChangedEvent = Schema.Schema.Type<
  typeof SessionTitleChangedEvent
>;

// deno-lint-ignore no-slow-types
const UserMessageData_ = Schema.Struct({
  parts: Schema.Array(Part),
  // The text the user actually typed, when it differs from the message
  // content — set when a custom slash command (/name args) was expanded
  // server-side into `parts`. Display surfaces (transcript, session title)
  // prefer this over the expanded text. Plain prompts omit it.
  sourceText: Schema.optional(Schema.String),
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
const TurnStartedData_ = Schema.Struct({
  turnId: Schema.String,
});
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
  turnId: Schema.String,
  stopReason: StopReason,
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
  turnId: Schema.String,
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

const ModelCallPurpose_ = Schema.Literals(["agent", "compaction"]);
export type ModelCallPurpose = Schema.Schema.Type<typeof ModelCallPurpose_>;
export const ModelCallPurpose: Schema.Codec<ModelCallPurpose> =
  ModelCallPurpose_;

const ModelCallActor_ = Schema.Literals(["main", "subagent"]);
export type ModelCallActor = Schema.Schema.Type<typeof ModelCallActor_>;
export const ModelCallActor: Schema.Codec<ModelCallActor> = ModelCallActor_;

const BillingMode_ = Schema.Literals(["subscription", "api", "unknown"]);
export type BillingMode = Schema.Schema.Type<typeof BillingMode_>;
export const BillingMode: Schema.Codec<BillingMode> = BillingMode_;

const modelCallBase = {
  callId: Schema.String,
  turnId: Schema.String,
  purpose: ModelCallPurpose_,
  actor: ModelCallActor_,
  providerId: Schema.String,
  modelId: Schema.String,
  billingMode: BillingMode_,
  durationMs: Schema.Number,
  attempts: Schema.Number,
};

// deno-lint-ignore no-slow-types
const ModelCallCompletedData_ = Schema.Struct({
  ...modelCallBase,
  finishReason: StopReason,
  usage: Usage,
});
export type ModelCallCompletedData = Schema.Schema.Type<
  typeof ModelCallCompletedData_
>;
export const ModelCallCompletedData: Schema.Codec<ModelCallCompletedData> =
  ModelCallCompletedData_;

export const ModelCallCompletedEvent = Schema.Struct({
  ...recordedBase,
  type: Schema.Literal("model.call.completed"),
  data: ModelCallCompletedData,
});
export type ModelCallCompletedEvent = Schema.Schema.Type<
  typeof ModelCallCompletedEvent
>;

// deno-lint-ignore no-slow-types
const ModelCallFailedData_ = Schema.Struct({
  ...modelCallBase,
  error: Schema.String,
});
export type ModelCallFailedData = Schema.Schema.Type<
  typeof ModelCallFailedData_
>;
export const ModelCallFailedData: Schema.Codec<ModelCallFailedData> =
  ModelCallFailedData_;

export const ModelCallFailedEvent = Schema.Struct({
  ...recordedBase,
  type: Schema.Literal("model.call.failed"),
  data: ModelCallFailedData,
});
export type ModelCallFailedEvent = Schema.Schema.Type<
  typeof ModelCallFailedEvent
>;

export const CompactionPerformedData = Schema.Struct({
  summaryMessageId: Schema.String,
  // "llm" = model-generated handoff summary (the summarizer call succeeded
  // and returned non-empty text); "template" = deterministic fallback used
  // when the summary call failed or returned empty.
  mode: Schema.Literals(["llm", "template"]),
  // The summary BODY (no SUMMARY_PREFIX — the context fold re-wraps it
  // when folding the event into the bridge message, so the marker convention
  // stays single-sourced). Replay replaces everything projected so far with
  // the bridge message.
  summary: Schema.String,
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
  // Short display name invented by the parent model at spawn time; shown in
  // the TUI agent strip.
  name: Schema.String,
  // The tool.call.requested id that triggered the spawn; links the parent
  // tool card to the child session.
  callId: Schema.String,
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
const SubagentCompletedData_ = Schema.Struct({
  parentSessionId: Schema.String,
  childSessionId: Schema.String,
  callId: Schema.String,
  ok: Schema.Boolean,
  // Token totals from the child's last model.call.completed; null when the
  // child recorded none (never fabricated zeroes).
  usage: Schema.NullOr(Schema.Struct({
    inputTokens: Schema.Number,
    outputTokens: Schema.Number,
  })),
  durationMs: Schema.Number,
});
export type SubagentCompletedData = Schema.Schema.Type<
  typeof SubagentCompletedData_
>;
export const SubagentCompletedData: Schema.Codec<SubagentCompletedData> =
  SubagentCompletedData_;

export const SubagentCompletedEvent = Schema.Struct({
  ...recordedBase,
  type: Schema.Literal("subagent.completed"),
  data: SubagentCompletedData_,
});
export type SubagentCompletedEvent = Schema.Schema.Type<
  typeof SubagentCompletedEvent
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
  SessionModelChangedEvent,
  SessionEffortChangedEvent,
  SessionTitleChangedEvent,
  UserMessageEvent,
  AssistantMessageEvent,
  ToolCallRequestedEvent,
  ToolCallApprovedEvent,
  ToolCallDeniedEvent,
  ToolResultEvent,
  TurnStartedEvent,
  TurnCompletedEvent,
  TurnAbortedEvent,
  ModelCallCompletedEvent,
  ModelCallFailedEvent,
  CompactionPerformedEvent,
  ApprovalRequestedEvent,
  ApprovalResolvedEvent,
  SubagentSpawnedEvent,
  SubagentCompletedEvent,
  ErrorOccurredEvent,
]);
export type RecordedEvent = Schema.Schema.Type<typeof RecordedEvent_>;
export const RecordedEvent: Schema.Codec<RecordedEvent> = RecordedEvent_;

// deno-lint-ignore no-slow-types
const RecordedEventType_ = Schema.Literals([
  "session.created",
  "session.model.changed",
  "session.effort.changed",
  "session.title.changed",
  "user.message",
  "assistant.message",
  "tool.call.requested",
  "tool.call.approved",
  "tool.call.denied",
  "tool.result",
  "turn.started",
  "turn.completed",
  "turn.aborted",
  "model.call.completed",
  "model.call.failed",
  "compaction.performed",
  "approval.requested",
  "approval.resolved",
  "subagent.spawned",
  "subagent.completed",
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

// Inputs bound to a turn but not yet consumed when that turn failed. This is
// deliberately live-only: accepted-but-unconsumed input is runtime state, not
// part of the durable conversation history. Clients may restore these as
// drafts, subject to their local editor collision rule.
// deno-lint-ignore no-slow-types
const InputRecoveredLive_ = Schema.Struct({
  ...liveBase,
  type: Schema.Literal("input.recovered"),
  data: Schema.Struct({
    reason: Schema.Literal("turn_failed"),
    inputs: Schema.Array(Schema.Struct({ sourceText: Schema.String })),
  }),
});
export type InputRecoveredLive = Schema.Schema.Type<
  typeof InputRecoveredLive_
>;
export const InputRecoveredLive: Schema.Codec<InputRecoveredLive> =
  InputRecoveredLive_;

// deno-lint-ignore no-slow-types
const LiveEvent_ = Schema.Union([
  ThinkingDeltaLive,
  TextDeltaLive,
  ToolProgressLive,
  TextResetLive,
  InputRecoveredLive,
]);
export type LiveEvent = Schema.Schema.Type<typeof LiveEvent_>;
export const LiveEvent: Schema.Codec<LiveEvent> = LiveEvent_;

// deno-lint-ignore no-slow-types
const LiveEventType_ = Schema.Literals([
  "thinking.delta",
  "text.delta",
  "tool.progress",
  "text.reset",
  "input.recovered",
]);
export type LiveEventType = Schema.Schema.Type<typeof LiveEventType_>;
export const LiveEventType: Schema.Codec<LiveEventType> = LiveEventType_;
