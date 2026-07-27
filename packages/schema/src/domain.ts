import { Schema } from "effect";

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
const ThinkingPart_ = Schema.Struct({
  type: Schema.Literal("thinking"),
  text: Schema.String,
  encrypted: Schema.optional(Schema.String),
});
export type ThinkingPart = Schema.Schema.Type<typeof ThinkingPart_>;
export const ThinkingPart: Schema.Codec<ThinkingPart> = ThinkingPart_;

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
const Part_ = Schema.Union([
  ThinkingPart,
  TextPart,
  ToolCallPart,
  ToolResultPart,
]);
export type Part = Schema.Schema.Type<typeof Part_>;
export const Part: Schema.Codec<Part> = Part_;

// deno-lint-ignore no-slow-types
const Usage_ = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
});
export type Usage = Schema.Schema.Type<typeof Usage_>;
export const Usage: Schema.Codec<Usage> = Usage_;
