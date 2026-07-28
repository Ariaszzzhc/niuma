import type { FinishReason, StreamEvent, Usage } from "./domain.ts";
import { InvalidResponse, Network } from "./errors.ts";

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface AnthropicContentBlock {
  type?: string;
  id?: string;
  name?: string;
  text?: string;
  thinking?: string;
  signature?: string;
  data?: string;
  input?: unknown;
}

interface AnthropicDelta {
  type?: string;
  text?: string;
  thinking?: string;
  partial_json?: string;
  signature?: string;
  stop_reason?: string | null;
}

interface AnthropicEvent {
  type?: string;
  index?: number;
  message?: { usage?: AnthropicUsage };
  content_block?: AnthropicContentBlock;
  delta?: AnthropicDelta;
  usage?: AnthropicUsage;
  error?: { type?: string; message?: string };
}

const parseFinishReason = (
  r: string | null | undefined,
): FinishReason | undefined => {
  if (!r) return undefined;
  switch (r) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return "stop";
  }
};

// Anthropic reports input_tokens on message_start and output_tokens on
// message_delta; thinking tokens are not broken out (billed as part of
// output_tokens), so reasoningTokens stays undefined.
const toUsage = (input: number, output: number): Usage => ({
  promptTokens: input,
  completionTokens: output,
  totalTokens: input + output,
});

export async function* parseAnthropicSSE(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Event type from the most recent `event:` line; Anthropic tags every data
  // payload with one, and the JSON body does not always repeat it.
  let eventType = "";
  let inputTokens = 0;
  let pendingFinish: FinishReason | undefined;
  let pendingUsage: Usage | undefined;
  let emittedFinish = false;
  // tool_use blocks stream their arguments as input_json_delta fragments; the
  // completed call is emitted whole on content_block_stop (same shape as the
  // OpenAI parser's flush).
  let currentTool: { id: string; name: string; args: string } | undefined;
  let currentRedactedData: string | undefined;

  const emitFinish = function* (terminal: string): Generator<StreamEvent> {
    if (emittedFinish) return;
    // Anthropic reports the semantic terminal reason in message_delta. A bare
    // EOF / [DONE] / message_stop without it is an interrupted or malformed
    // stream, not a clean end_turn. Surface it as retryable Network so the
    // agent's mid-stream retry path discards partial deltas and re-samples.
    if (pendingFinish === undefined) {
      throw new Network({
        cause: new Error(
          `Anthropic SSE reached ${terminal} without a stop_reason`,
        ),
      });
    }
    emittedFinish = true;
    if (pendingUsage) {
      yield {
        _tag: "Finish" as const,
        reason: pendingFinish,
        usage: pendingUsage,
      };
    } else {
      yield { _tag: "Finish" as const, reason: pendingFinish };
    }
  };

  const handleEvent = function* (evt: AnthropicEvent): Generator<StreamEvent> {
    switch (eventType || evt.type) {
      case "message_start":
        inputTokens = evt.message?.usage?.input_tokens ?? inputTokens;
        break;
      case "content_block_start": {
        const block = evt.content_block;
        if (!block) break;
        if (block.type === "tool_use") {
          currentTool = {
            id: block.id ?? "",
            name: block.name ?? "",
            args: "",
          };
        } else if (block.type === "redacted_thinking") {
          currentRedactedData = block.data;
        }
        break;
      }
      case "content_block_delta": {
        const delta = evt.delta;
        if (!delta) break;
        switch (delta.type) {
          case "text_delta":
            if (delta.text) {
              yield { _tag: "TextDelta" as const, text: delta.text };
            }
            break;
          case "thinking_delta":
            yield {
              _tag: "ThinkingDelta" as const,
              text: delta.thinking ?? "",
            };
            break;
          // Pure credential delta: the signature is an opaque replay token,
          // carried verbatim and never interpreted here.
          case "signature_delta":
            yield {
              _tag: "ThinkingDelta" as const,
              text: "",
              encrypted: delta.signature,
            };
            break;
          case "input_json_delta":
            if (currentTool && delta.partial_json) {
              currentTool.args += delta.partial_json;
            }
            break;
        }
        break;
      }
      case "content_block_stop":
        if (currentTool) {
          yield {
            _tag: "ToolCall" as const,
            id: currentTool.id,
            name: currentTool.name,
            arguments: currentTool.args,
          };
          currentTool = undefined;
        } else if (currentRedactedData !== undefined) {
          yield {
            _tag: "ThinkingDelta" as const,
            text: "",
            encrypted: currentRedactedData,
          };
          currentRedactedData = undefined;
        }
        break;
      case "message_delta": {
        if (evt.delta?.stop_reason) {
          pendingFinish = parseFinishReason(evt.delta.stop_reason);
        }
        const outputTokens = evt.usage?.output_tokens;
        if (outputTokens !== undefined) {
          pendingUsage = toUsage(inputTokens, outputTokens);
        }
        break;
      }
      case "message_stop":
        yield* emitFinish("message_stop");
        break;
      case "ping":
        break;
      case "error":
        throw new InvalidResponse({
          message: evt.error?.message ?? "Anthropic stream error",
        });
      default:
        // Unrecognized event types are ignored, mirroring the OpenAI parser.
        break;
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

        if (line.startsWith("event:")) {
          eventType = line.slice(6).trimStart();
          continue;
        }
        if (!line.startsWith("data:")) continue;

        const payload = line.slice(5).trimStart();
        if (payload === "[DONE]") {
          yield* emitFinish("[DONE]");
          return;
        }

        let parsed: AnthropicEvent;
        try {
          parsed = JSON.parse(payload) as AnthropicEvent;
        } catch {
          throw new InvalidResponse({
            message: `Failed to parse SSE JSON: ${payload}`,
          });
        }

        yield* handleEvent(parsed);
        eventType = "";
      }
    }
    if (signal.aborted) return;
    yield* emitFinish("EOF");
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}
