import type { FinishReason, StreamEvent, Usage } from "./domain.ts";
import { InvalidResponse, Network } from "./errors.ts";

// Responses API streaming event payloads. Only the fields niuma reads are
// declared; the full Responses event surface (computer use, file search, MCP,
// web search, image gen, code interpreter) is intentionally absent. Unknown
// event types are skipped (forward-compatible), mirroring sse.ts /
// anthropic_sse.ts - the parser grows in place the way anthropic_sse.ts did
// if the surface later widens.
interface ResponsesUsageWire {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly total_tokens?: number;
  readonly output_tokens_details?: { readonly reasoning_tokens?: number };
  readonly input_tokens_details?: { readonly cached_tokens?: number };
}

interface ResponsesItemWire {
  readonly type?: string;
  // function_call fields.
  readonly call_id?: string;
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: string;
  // reasoning fields.
  readonly encrypted_content?: string;
}

interface ResponsesEvent {
  readonly type?: string;
  readonly delta?: string;
  readonly item?: ResponsesItemWire;
  readonly response?: {
    readonly status?: string;
    readonly incomplete_details?: { readonly reason?: string };
    readonly usage?: ResponsesUsageWire;
    /** Present on a `response.failed` event (server-side turn failure). */
    readonly error?: { readonly message?: string; readonly code?: string };
  };
}

// Responses reports input/output/total tokens; reasoning tokens are broken
// out under output_tokens_details. totalTokens falls back to input+output when
// the wire omits total_tokens (some events do). reasoningTokens is omitted
// entirely when the provider does not break it out (matching the optional
// domain field's semantics and the Anthropic parser, so assertEquals does not
// see a present-but-undefined key).
const toUsage = (u: ResponsesUsageWire): Usage => {
  const prompt = u.input_tokens;
  const completion = u.output_tokens;
  const total = u.total_tokens ??
    (prompt !== undefined && completion !== undefined
      ? prompt + completion
      : undefined);
  const reasoning = u.output_tokens_details?.reasoning_tokens;
  const cached = u.input_tokens_details?.cached_tokens;
  return {
    ...(prompt !== undefined ? { promptTokens: prompt } : {}),
    ...(completion !== undefined ? { completionTokens: completion } : {}),
    ...(total !== undefined ? { totalTokens: total } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
  };
};

// FinishReason precedence: tool_calls wins over stop (matches how
// parseOpenAISSE lets the last finish_reason stand when a tool_calls turn
// also reports "completed"). Otherwise status "completed" -> stop; an
// "incomplete" response whose incomplete_details reason is max_output_tokens
// -> length; anything else -> stop.
const finishReasonFrom = (
  response: ResponsesEvent["response"],
  sawToolCall: boolean,
): FinishReason => {
  if (sawToolCall) return "tool_calls";
  if (response?.status === "incomplete") {
    if (response.incomplete_details?.reason === "max_output_tokens") {
      return "length";
    }
  }
  return "stop";
};

export async function* parseResponsesSSE(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawToolCall = false;
  let pendingUsage: Usage | undefined;
  let pendingReason: FinishReason | undefined;
  let emittedFinish = false;

  const emitFinish = function* (): Generator<StreamEvent> {
    if (emittedFinish) return;
    emittedFinish = true;
    const reason = pendingReason ?? finishReasonFrom(undefined, sawToolCall);
    if (pendingUsage) {
      yield { _tag: "Finish" as const, reason, usage: pendingUsage };
    } else {
      yield { _tag: "Finish" as const, reason };
    }
  };

  // The Responses stream tags every data payload with an `event:` line, but the
  // JSON body also carries the same string in `type`, so we key off `type`
  // alone (authoritative, always present) and let the `event:` lines be
  // skipped like any other non-`data:` line - same filter sse.ts uses.
  const handleEvent = function* (evt: ResponsesEvent): Generator<StreamEvent> {
    switch (evt.type) {
      case "response.output_text.delta":
        if (evt.delta) {
          yield { _tag: "TextDelta" as const, text: evt.delta };
        }
        break;
      case "response.reasoning_summary_text.delta":
        // Summary text streams incrementally; these carry no replay
        // credential (encrypted_content arrives separately on output_item.done).
        yield {
          _tag: "ThinkingDelta" as const,
          text: evt.delta ?? "",
        };
        break;
      case "response.output_item.done": {
        const item = evt.item;
        if (!item) break;
        if (
          item.type === "reasoning" && item.encrypted_content !== undefined
        ) {
          // Trailing replay credential: the opaque encrypted_content is
          // carried verbatim (design rule 3). Text is empty because the
          // summary already streamed via reasoning_summary_text.delta; this
          // delta exists only to surface the credential.
          yield {
            _tag: "ThinkingDelta" as const,
            text: "",
            encrypted: item.encrypted_content,
          };
        } else if (item.type === "function_call") {
          // The complete function call (call_id + name + assembled arguments)
          // arrives in output_item.done; the function_call_arguments.delta
          // fragments that precede it are intentionally NOT buffered - the
          // whole call is emitted here, matching how the OpenAI parser waits
          // for the choice to finish before flushing. call_id is the handle
          // function_call_output items reference; fall back to item.id.
          sawToolCall = true;
          yield {
            _tag: "ToolCall" as const,
            id: item.call_id ?? item.id ?? "",
            name: item.name ?? "",
            arguments: item.arguments ?? "",
          };
        }
        break;
      }
      case "response.completed":
      case "response.incomplete": {
        const usage = evt.response?.usage;
        if (usage) pendingUsage = toUsage(usage);
        pendingReason = finishReasonFrom(evt.response, sawToolCall);
        yield* emitFinish();
        break;
      }
      case "response.failed": {
        // A server-side turn failure (rate-limit wall, content policy, internal
        // error mid-stream). Throwing InvalidResponse surfaces it through the
        // same channel as malformed JSON — without this arm the parser would
        // fall through to `default:` (skip), then synthesize a Finish{reason:
        // "stop"} at end-of-stream, silently masking a failed turn as a clean
        // stop. The error taxonomy (InvalidResponse is non-retryable) matches
        // how an HTTP-level failure would be classified before the stream began.
        const err = evt.response?.error;
        throw new InvalidResponse({
          message: `Responses stream failed: ${
            err?.message ?? err?.code ?? "unknown error"
          }`,
        });
      }
      default:
        // Unrecognised event types are ignored (forward-compatible), mirroring
        // the OpenAI/Anthropic parsers - a future event the parser does not
        // model yet must not break an in-flight stream.
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
        // event:/id:/retry: lines are not data - skip them. The JSON `type`
        // field is authoritative for Responses events.
        if (!line.startsWith("data:")) continue;

        const payload = line.slice(5).trimStart();
        if (payload === "[DONE]") {
          yield* emitFinish();
          return;
        }

        let parsed: ResponsesEvent;
        try {
          parsed = JSON.parse(payload) as ResponsesEvent;
        } catch {
          throw new InvalidResponse({
            message: `Failed to parse SSE JSON: ${payload}`,
          });
        }

        yield* handleEvent(parsed);
      }
    }
    yield* emitFinish();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}
