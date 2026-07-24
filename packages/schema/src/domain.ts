import { Schema } from "effect";

// deno-lint-ignore no-slow-types
const Role_ = Schema.Literals(["system", "user", "assistant", "tool"]);
export type Role = Schema.Schema.Type<typeof Role_>;
export const Role: Schema.Codec<Role> = Role_;

// deno-lint-ignore no-slow-types
const StopReason_ = Schema.Literals([
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
export type StopReason = Schema.Schema.Type<typeof StopReason_>;
export const StopReason: Schema.Codec<StopReason> = StopReason_;

// deno-lint-ignore no-slow-types
const TextPart_ = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});
export type TextPart = Schema.Schema.Type<typeof TextPart_>;
export const TextPart: Schema.Codec<TextPart> = TextPart_;

// `input` is the raw tool arguments — arbitrary JSON object the provider emits;
// the provider adapter is responsible for producing/consuming it.
// deno-lint-ignore no-slow-types
const ToolCallPart_ = Schema.Struct({
  type: Schema.Literal("tool_call"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
});
export type ToolCallPart = Schema.Schema.Type<typeof ToolCallPart_>;
export const ToolCallPart: Schema.Codec<ToolCallPart> = ToolCallPart_;

// deno-lint-ignore no-slow-types
const TextResultBlock_ = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});
export type TextResultBlock = Schema.Schema.Type<typeof TextResultBlock_>;
export const TextResultBlock: Schema.Codec<TextResultBlock> = TextResultBlock_;

// deno-lint-ignore no-slow-types
const ToolResultContent_ = Schema.Union([
  Schema.String,
  Schema.Array(TextResultBlock),
]);
export type ToolResultContent = Schema.Schema.Type<typeof ToolResultContent_>;
export const ToolResultContent: Schema.Codec<ToolResultContent> =
  ToolResultContent_;

// deno-lint-ignore no-slow-types
const ToolResultPart_ = Schema.Struct({
  type: Schema.Literal("tool_result"),
  toolCallId: Schema.String,
  content: ToolResultContent,
  isError: Schema.Boolean,
});
export type ToolResultPart = Schema.Schema.Type<typeof ToolResultPart_>;
export const ToolResultPart: Schema.Codec<ToolResultPart> = ToolResultPart_;

// deno-lint-ignore no-slow-types
const Part_ = Schema.Union([TextPart, ToolCallPart, ToolResultPart]);
export type Part = Schema.Schema.Type<typeof Part_>;
export const Part: Schema.Codec<Part> = Part_;

// deno-lint-ignore no-slow-types
const Message_ = Schema.Struct({
  role: Role,
  parts: Schema.Array(Part),
});
export type Message = Schema.Schema.Type<typeof Message_>;
export const Message: Schema.Codec<Message> = Message_;

// deno-lint-ignore no-slow-types
const Usage_ = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
});
export type Usage = Schema.Schema.Type<typeof Usage_>;
export const Usage: Schema.Codec<Usage> = Usage_;

// `parameters` is a JSON Schema object describing the tool input shape.
// deno-lint-ignore no-slow-types
const ToolParameters_ = Schema.Record(Schema.String, Schema.Unknown);
export type ToolParameters = Schema.Schema.Type<typeof ToolParameters_>;
export const ToolParameters: Schema.Codec<ToolParameters> = ToolParameters_;

// deno-lint-ignore no-slow-types
const ToolDef_ = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  parameters: ToolParameters,
});
export type ToolDef = Schema.Schema.Type<typeof ToolDef_>;
export const ToolDef: Schema.Codec<ToolDef> = ToolDef_;

// deno-lint-ignore no-slow-types
const ModelRef_ = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
});
export type ModelRef = Schema.Schema.Type<typeof ModelRef_>;
export const ModelRef: Schema.Codec<ModelRef> = ModelRef_;

// ---- Provider stream events (flat, consumed by the agent loop) ----

// deno-lint-ignore no-slow-types
const TextDelta_ = Schema.Struct({
  type: Schema.Literal("text.delta"),
  delta: Schema.String,
});
export type TextDelta = Schema.Schema.Type<typeof TextDelta_>;
export const TextDelta: Schema.Codec<TextDelta> = TextDelta_;

// deno-lint-ignore no-slow-types
const ToolCallBegin_ = Schema.Struct({
  type: Schema.Literal("tool_call.begin"),
  id: Schema.String,
  name: Schema.String,
});
export type ToolCallBegin = Schema.Schema.Type<typeof ToolCallBegin_>;
export const ToolCallBegin: Schema.Codec<ToolCallBegin> = ToolCallBegin_;

// deno-lint-ignore no-slow-types
const ToolCallDelta_ = Schema.Struct({
  type: Schema.Literal("tool_call.delta"),
  id: Schema.String,
  delta: Schema.String,
});
export type ToolCallDelta = Schema.Schema.Type<typeof ToolCallDelta_>;
export const ToolCallDelta: Schema.Codec<ToolCallDelta> = ToolCallDelta_;

// deno-lint-ignore no-slow-types
const ToolCallEnd_ = Schema.Struct({
  type: Schema.Literal("tool_call.end"),
  id: Schema.String,
  input: Schema.Unknown,
});
export type ToolCallEnd = Schema.Schema.Type<typeof ToolCallEnd_>;
export const ToolCallEnd: Schema.Codec<ToolCallEnd> = ToolCallEnd_;

// deno-lint-ignore no-slow-types
const MessageDone_ = Schema.Struct({
  type: Schema.Literal("message.done"),
  usage: Usage,
  stopReason: Schema.optional(StopReason),
});
export type MessageDone = Schema.Schema.Type<typeof MessageDone_>;
export const MessageDone: Schema.Codec<MessageDone> = MessageDone_;

// deno-lint-ignore no-slow-types
const StreamError_ = Schema.Struct({
  type: Schema.Literal("stream.error"),
  message: Schema.String,
  retryable: Schema.optional(Schema.Boolean),
});
export type StreamError = Schema.Schema.Type<typeof StreamError_>;
export const StreamError: Schema.Codec<StreamError> = StreamError_;

// deno-lint-ignore no-slow-types
const StreamEvent_ = Schema.Union([
  TextDelta,
  ToolCallBegin,
  ToolCallDelta,
  ToolCallEnd,
  MessageDone,
  StreamError,
]);
export type StreamEvent = Schema.Schema.Type<typeof StreamEvent_>;
export const StreamEvent: Schema.Codec<StreamEvent> = StreamEvent_;
