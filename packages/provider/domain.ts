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
}

export interface ToolDef {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: Record<string, unknown>;
}

export interface Usage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
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
  readonly abort?: AbortSignal;
}
