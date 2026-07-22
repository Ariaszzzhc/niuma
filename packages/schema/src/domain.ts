import { Schema } from "effect";

export const Role = Schema.Literals(["system", "user", "assistant", "tool"]);
export type Role = Schema.Schema.Type<typeof Role>;

export const StopReason = Schema.Literals([
  "stop",
  "length",
  "tool_calls",
  "content_filter",
  "abort",
  // Terminal provider/stream failure mid-turn (retries exhausted or fatal
  // error). Flows into turn.completed + sessions.last_stop_reason; the column
  // is unconstrained TEXT so no migration is needed.
  "error",
]);
export type StopReason = Schema.Schema.Type<typeof StopReason>;

export const TextPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});
export type TextPart = Schema.Schema.Type<typeof TextPart>;

// `input` is the raw tool arguments — arbitrary JSON object the provider emits;
// the provider adapter is responsible for producing/consuming it.
export const ToolCallPart = Schema.Struct({
  type: Schema.Literal("tool_call"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
});
export type ToolCallPart = Schema.Schema.Type<typeof ToolCallPart>;

export const TextResultBlock = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});
export type TextResultBlock = Schema.Schema.Type<typeof TextResultBlock>;

export const ToolResultContent = Schema.Union([
  Schema.String,
  Schema.Array(TextResultBlock),
]);
export type ToolResultContent = Schema.Schema.Type<typeof ToolResultContent>;

export const ToolResultPart = Schema.Struct({
  type: Schema.Literal("tool_result"),
  toolCallId: Schema.String,
  content: ToolResultContent,
  isError: Schema.Boolean,
});
export type ToolResultPart = Schema.Schema.Type<typeof ToolResultPart>;

export const Part = Schema.Union([TextPart, ToolCallPart, ToolResultPart]);
export type Part = Schema.Schema.Type<typeof Part>;

export const Message = Schema.Struct({
  role: Role,
  parts: Schema.Array(Part),
});
export type Message = Schema.Schema.Type<typeof Message>;

export const Usage = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
});
export type Usage = Schema.Schema.Type<typeof Usage>;

// `parameters` is a JSON Schema object describing the tool input shape.
export const ToolParameters = Schema.Record(Schema.String, Schema.Unknown);
export type ToolParameters = Schema.Schema.Type<typeof ToolParameters>;

export const ToolDef = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  parameters: ToolParameters,
});
export type ToolDef = Schema.Schema.Type<typeof ToolDef>;

export const ModelRef = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
});
export type ModelRef = Schema.Schema.Type<typeof ModelRef>;

// ---- Provider stream events (flat, consumed by the agent loop) ----

export const TextDelta = Schema.Struct({
  type: Schema.Literal("text.delta"),
  delta: Schema.String,
});
export type TextDelta = Schema.Schema.Type<typeof TextDelta>;

export const ToolCallBegin = Schema.Struct({
  type: Schema.Literal("tool_call.begin"),
  id: Schema.String,
  name: Schema.String,
});
export type ToolCallBegin = Schema.Schema.Type<typeof ToolCallBegin>;

export const ToolCallDelta = Schema.Struct({
  type: Schema.Literal("tool_call.delta"),
  id: Schema.String,
  delta: Schema.String,
});
export type ToolCallDelta = Schema.Schema.Type<typeof ToolCallDelta>;

export const ToolCallEnd = Schema.Struct({
  type: Schema.Literal("tool_call.end"),
  id: Schema.String,
  input: Schema.Unknown,
});
export type ToolCallEnd = Schema.Schema.Type<typeof ToolCallEnd>;

export const MessageDone = Schema.Struct({
  type: Schema.Literal("message.done"),
  usage: Usage,
  stopReason: Schema.optional(StopReason),
});
export type MessageDone = Schema.Schema.Type<typeof MessageDone>;

export const StreamError = Schema.Struct({
  type: Schema.Literal("stream.error"),
  message: Schema.String,
  retryable: Schema.optional(Schema.Boolean),
});
export type StreamError = Schema.Schema.Type<typeof StreamError>;

export const StreamEvent = Schema.Union([
  TextDelta,
  ToolCallBegin,
  ToolCallDelta,
  ToolCallEnd,
  MessageDone,
  StreamError,
]);
export type StreamEvent = Schema.Schema.Type<typeof StreamEvent>;
