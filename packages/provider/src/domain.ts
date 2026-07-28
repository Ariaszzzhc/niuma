export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface Message {
  readonly role: Role;
  readonly content: string;
  readonly toolCalls?: ReadonlyArray<ToolCall>;
  readonly toolCallId?: string;
  readonly name?: string;
  // Provider reasoning/thinking replayed back to the wire on a follow-up
  // turn (convert-layer product). `keep` filtering happens upstream in the
  // context projection layer; this field is the raw material. The array
  // mirrors ThinkingPart's multi-block structure: each block's `text` is the
  // cross-provider body, `encrypted` is an opaque replay credential (e.g.
  // Anthropic signature) held verbatim for credential-protocol providers.
  readonly reasoningContent?: ReadonlyArray<{
    readonly text: string;
    readonly encrypted?: string;
  }>;
}

export interface ToolDef {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: Record<string, unknown>;
}

export interface Usage {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  // Reasoning/thinking token consumption, when the provider breaks it out
  // (OpenAI: completion_tokens_details.reasoning_tokens). Absent when the
  // provider does not report it.
  readonly reasoningTokens?: number;
  /** Provider-reported input tokens served from a prompt cache. */
  readonly cachedInputTokens?: number;
  /** Provider-reported input tokens written into a prompt cache. */
  readonly cacheWriteTokens?: number;
}

export interface ModelRef {
  readonly id: string;
  readonly name?: string;
  readonly contextWindow?: number;
}

export type FinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter";

export type StreamEvent =
  | { readonly _tag: "TextDelta"; readonly text: string }
  | {
    // Incremental reasoning/thinking text. `text` is the cross-provider body;
    // `encrypted` is an opaque replay credential (e.g. Anthropic signature,
    // Responses API encrypted_content) delivered as a trailing delta. The
    // OpenAI Chat Completions family never sets `encrypted`.
    readonly _tag: "ThinkingDelta";
    readonly text: string;
    readonly encrypted?: string;
  }
  | {
    readonly _tag: "ToolCall";
    readonly id: string;
    readonly name: string;
    readonly arguments: string;
  }
  | {
    readonly _tag: "Finish";
    readonly reason: FinishReason;
    readonly usage?: Usage;
  };

export interface ChatRequest {
  readonly model: string;
  readonly system?: string;
  readonly messages: ReadonlyArray<Message>;
  readonly tools: ReadonlyArray<ToolDef>;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly thinking?: ThinkingConfig;
  readonly abort?: AbortSignal;
}

// Thinking/reasoning configuration. `effort` is a provider-defined档位 string
// (e.g. OpenAI reasoning_effort: minimal/low/medium/high) passed through
// verbatim — niuma defines no enum and performs no mapping/convergence, since
// the legal values are part of each provider's wire protocol. `keep` controls
// whether prior reasoning is replayed back to the provider on follow-up turns
// (default "all"; "none" strips it at the context projection layer).
export interface ThinkingConfig {
  readonly effort?: string;
  readonly keep?: "all" | "none";
}
