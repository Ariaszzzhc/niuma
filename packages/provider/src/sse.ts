import type { FinishReason, StreamEvent, Usage } from "./domain.ts";
import { InvalidResponse, Network } from "./errors.ts";

interface ToolCallBuf {
  id: string;
  name: string;
  args: string;
  hasId: boolean;
  hasName: boolean;
}

interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIDelta {
  role?: string;
  content?: string;
  reasoning_content?: string;
  tool_calls?: OpenAIToolCallDelta[];
}

interface OpenAIChoice {
  index: number;
  delta?: OpenAIDelta;
  finish_reason?: string | null;
}

interface OpenAIStreamChunk {
  choices?: OpenAIChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
  };
}

const parseFinishReason = (
  r: string | null | undefined,
): FinishReason | undefined => {
  if (!r) return undefined;
  switch (r) {
    case "stop":
    case "length":
    case "tool_calls":
    case "content_filter":
      return r;
    default:
      return "stop";
  }
};

const toUsage = (u: NonNullable<OpenAIStreamChunk["usage"]>): Usage => ({
  ...(u.prompt_tokens !== undefined ? { promptTokens: u.prompt_tokens } : {}),
  ...(u.completion_tokens !== undefined
    ? { completionTokens: u.completion_tokens }
    : {}),
  ...(u.total_tokens !== undefined ? { totalTokens: u.total_tokens } : {}),
  ...(u.completion_tokens_details?.reasoning_tokens !== undefined
    ? {
      reasoningTokens: u.completion_tokens_details.reasoning_tokens,
    }
    : {}),
  ...(u.prompt_tokens_details?.cached_tokens !== undefined
    ? { cachedInputTokens: u.prompt_tokens_details.cached_tokens }
    : {}),
});

export async function* parseOpenAISSE(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const toolCalls = new Map<number, ToolCallBuf>();
  let pendingFinish: FinishReason | undefined;
  let emittedFinish = false;

  const flushToolCalls = function* (): Generator<StreamEvent> {
    const indices = Array.from(toolCalls.keys()).sort((a, b) => a - b);
    for (const i of indices) {
      const tc = toolCalls.get(i)!;
      yield {
        _tag: "ToolCall" as const,
        id: tc.id,
        name: tc.name,
        arguments: tc.args,
      };
    }
    toolCalls.clear();
  };

  const emitFinish = function* (usage?: Usage): Generator<StreamEvent> {
    if (emittedFinish) return;
    emittedFinish = true;
    const reason = pendingFinish ?? "stop";
    if (usage) {
      yield { _tag: "Finish" as const, reason, usage };
    } else {
      yield { _tag: "Finish" as const, reason };
    }
  };

  try {
    while (true) {
      let read: { done: boolean; value?: Uint8Array };
      try {
        read = await reader.read();
      } catch (err) {
        if (signal.aborted) return;
        throw new Network({ cause: err });
      }
      if (read.done) break;
      buffer += decoder.decode(read.value!, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const rawLine = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line.length === 0) continue;
        if (line.startsWith(":")) continue;
        if (!line.startsWith("data:")) continue;

        const payload = line.slice(5).trimStart();
        if (payload === "[DONE]") {
          yield* flushToolCalls();
          yield* emitFinish();
          return;
        }

        let parsed: OpenAIStreamChunk;
        try {
          parsed = JSON.parse(payload) as OpenAIStreamChunk;
        } catch {
          throw new InvalidResponse({
            message: `Failed to parse SSE JSON: ${payload}`,
          });
        }

        if (parsed.usage) {
          yield* flushToolCalls();
          yield* emitFinish(toUsage(parsed.usage));
          continue;
        }

        const choice = parsed.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta;
        if (delta?.content) {
          yield { _tag: "TextDelta" as const, text: delta.content };
        }
        // Chat Completions family streams thinking as reasoning_content deltas;
        // these carry no replay credential, so encrypted is never set here.
        if (delta?.reasoning_content) {
          yield {
            _tag: "ThinkingDelta" as const,
            text: delta.reasoning_content,
          };
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existing = toolCalls.get(tc.index);
            if (!existing) {
              toolCalls.set(tc.index, {
                id: tc.id ?? "",
                name: tc.function?.name ?? "",
                args: tc.function?.arguments ?? "",
                hasId: tc.id !== undefined,
                hasName: tc.function?.name !== undefined,
              });
            } else {
              if (tc.id !== undefined && !existing.hasId) {
                existing.id = tc.id;
                existing.hasId = true;
              }
              if (tc.function?.name !== undefined && !existing.hasName) {
                existing.name = tc.function.name;
                existing.hasName = true;
              }
              if (tc.function?.arguments !== undefined) {
                existing.args += tc.function.arguments;
              }
            }
          }
        }
        if (choice.finish_reason) {
          pendingFinish = parseFinishReason(choice.finish_reason);
        }
      }
    }
    yield* flushToolCalls();
    yield* emitFinish();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}
