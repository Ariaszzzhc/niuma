import type { Message, ToolCall, ToolDef } from "./domain.ts";

export interface OpenAIToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface OpenAITool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters?: Record<string, unknown>;
  };
}

export type OpenAIMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | {
    readonly role: "assistant";
    readonly content: string | null;
    readonly tool_calls?: ReadonlyArray<OpenAIToolCall>;
  }
  | {
    readonly role: "tool";
    readonly content: string;
    readonly tool_call_id: string;
  };

export const messagesToOpenAI = (
  messages: ReadonlyArray<Message>,
): OpenAIMessage[] =>
  messages.map((m): OpenAIMessage => {
    switch (m.role) {
      case "system":
        return { role: "system", content: m.content };
      case "user":
        return { role: "user", content: m.content };
      case "tool":
        return {
          role: "tool",
          content: m.content,
          tool_call_id: m.toolCallId ?? "",
        };
      case "assistant": {
        const calls = m.toolCalls;
        if (calls && calls.length > 0) {
          return {
            role: "assistant",
            content: m.content,
            tool_calls: calls.map((tc) => ({
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: tc.arguments },
            })),
          };
        }
        return { role: "assistant", content: m.content };
      }
    }
  });

export const toolsToOpenAI = (
  tools: ReadonlyArray<ToolDef>,
): OpenAITool[] =>
  tools.map((t): OpenAITool => ({
    type: "function",
    function: {
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      ...(t.parameters !== undefined ? { parameters: t.parameters } : {}),
    },
  }));

export const openAIToMessages = (
  messages: ReadonlyArray<OpenAIMessage>,
): Message[] =>
  messages.map((m): Message => {
    switch (m.role) {
      case "system":
        return { role: "system", content: m.content };
      case "user":
        return { role: "user", content: m.content };
      case "tool":
        return {
          role: "tool",
          content: m.content,
          toolCallId: m.tool_call_id,
        };
      case "assistant": {
        const calls = m.tool_calls;
        const toolCalls: ToolCall[] | undefined =
          calls && calls.length > 0
            ? calls.map((tc) => ({
              id: tc.id,
              name: tc.function.name,
              arguments: tc.function.arguments,
            }))
            : undefined;
        const base: Message = {
          role: "assistant",
          content: m.content ?? "",
        };
        return toolCalls ? { ...base, toolCalls } : base;
      }
    }
  });
