import { Effect, Layer, Stream } from "effect";
import { niumaFetch } from "./http.ts";
import { Provider, type ProviderAdapter } from "./contract.ts";
import type { ChatRequest, Message, ModelRef, ToolDef } from "./domain.ts";
import {
  InvalidResponse,
  Network,
  type ProviderError,
} from "./errors.ts";
import { withRetry } from "./retry.ts";
import { parseAnthropicSSE } from "./anthropic_sse.ts";
// Shared with openai.ts / responses.ts: the HTTP -> ProviderError ladder is
// extracted once so every fetch-based adapter classifies identically.
// Anthropic's 529 "overloaded" status falls in the >= 500 band the shared
// ladder already treats as transient overload.
import { classifyResponse } from "./classify.ts";

export interface AnthropicProviderConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly defaultModel: string;
}

// NOTE: this package deliberately knows nothing about where configuration
// comes from. Credentials/endpoints are loaded by @niuma/config (config.toml
// + auth.json) and passed in explicitly by the caller (server bootstrap).
// No Deno.env reads here.

const trimUrl = (u: string): string => u.replace(/\/+$/, "");

const normalizeConfig = (
  config: AnthropicProviderConfig,
): AnthropicProviderConfig => ({ ...config, baseUrl: trimUrl(config.baseUrl) });

const isAbortError = (e: unknown): boolean =>
  e instanceof Error &&
  (e.name === "AbortError" || e.name === "TimeoutError");

// Anthropic authenticates with a custom header pair, not an OAuth-style
// bearer. `anthropic-version` pins the Messages API shape we target.
const ANTHROPIC_VERSION = "2023-06-01";
const headersFor = (apiKey: string): HeadersInit => ({
  "content-type": "application/json",
  "x-api-key": apiKey,
  "anthropic-version": ANTHROPIC_VERSION,
});

// =============================================================================
// Convert (niuma Message[] → Anthropic messages)
// =============================================================================
// Wire types live in this file and nowhere else: per the niuma design rule,
// vendor field names (`tool_use`, `thinking`, `signature`, `tool_result`,
// `input_schema`) are this provider's private vocabulary and must not leak
// into the core domain or the OpenAI convert layer.

export type AnthropicTextBlock = {
  readonly type: "text";
  readonly text: string;
};
export type AnthropicThinkingBlock = {
  readonly type: "thinking";
  readonly thinking: string;
  // Anthropic's replay credential — the signed `signature` that lets a prior
  // thinking block round-trip back through the API.
  readonly signature: string;
};
export type AnthropicToolUseBlock = {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
};
export type AnthropicToolResultBlock = {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content: string;
  // niuma's Message carries no error flag, so `is_error` is never emitted here.
};
export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicThinkingBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export type AnthropicMessage = {
  readonly role: "user" | "assistant";
  readonly content: ReadonlyArray<AnthropicContentBlock>;
};

export type AnthropicTool = {
  readonly name: string;
  readonly description?: string;
  readonly input_schema: Record<string, unknown>;
};

// Tool-call arguments arrive as a JSON string; Anthropic wants a parsed
// object. When the string is malformed or not an object, envelope it under
// `_raw` so the value survives the round-trip instead of being dropped.
const parseToolInput = (args: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(args);
    if (
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to the raw envelope
  }
  return { _raw: args };
};

export const messagesToAnthropic = (
  messages: ReadonlyArray<Message>,
): AnthropicMessage[] => {
  const out: AnthropicMessage[] = [];
  // Accumulated tool_result blocks waiting to be flushed as one user turn.
  let pendingToolResults: AnthropicToolResultBlock[] = [];

  const flushToolResults = (): void => {
    if (pendingToolResults.length > 0) {
      out.push({ role: "user", content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const m of messages) {
    if (m.role === "system") {
      // System is hoisted to the top-level `system` field by buildBody; it
      // never appears in Anthropic's message list. Skip defensively in case a
      // system Message slips through alongside the `system` request field.
      continue;
    }
    if (m.role === "tool") {
      // Anthropic has no `tool` role: tool results ride as `tool_result`
      // blocks inside a `user` message. Consecutive tool results accumulate
      // and flush as a single user turn — Anthropic requires one user message
      // per batch of results, not one per result.
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: m.toolCallId ?? "",
        content: m.content,
      });
      continue;
    }
    flushToolResults();
    if (m.role === "user") {
      out.push({ role: "user", content: [{ type: "text", text: m.content }] });
      continue;
    }
    // assistant
    const content: AnthropicContentBlock[] = [];
    // Thinking replay (the load-bearing case for this provider): only blocks
    // carrying an `encrypted` credential go back, mapped to a signed
    // `thinking` block at the front of the turn. Blocks without `encrypted`
    // originated from a non-Anthropic provider as plain-text reasoning and
    // carry no signature Anthropic can verify — a signature-less `thinking`
    // block is rejected by the API, and folding their text into the visible
    // body would pollute the conversation. Discard them outright rather than
    // degrade.
    for (const b of m.reasoningContent ?? []) {
      if (b.encrypted !== undefined) {
        content.push({
          type: "thinking",
          thinking: b.text,
          signature: b.encrypted,
        });
      }
    }
    if (m.content !== "") {
      content.push({ type: "text", text: m.content });
    }
    for (const tc of m.toolCalls ?? []) {
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.name,
        input: parseToolInput(tc.arguments),
      });
    }
    out.push({ role: "assistant", content });
  }
  flushToolResults();
  return out;
};

export const toolsToAnthropic = (
  tools: ReadonlyArray<ToolDef>,
): AnthropicTool[] =>
  tools.map((t): AnthropicTool => ({
    name: t.name,
    ...(t.description !== undefined ? { description: t.description } : {}),
    // input_schema is required by Anthropic; default to an empty schema
    // (accepts any object) when the caller leaves parameters unspecified.
    input_schema: t.parameters ?? {},
  }));

// =============================================================================
// Request body
// =============================================================================
// Anthropic thinking vocabulary — this provider's private glossary. niuma core
// hands `effort` through verbatim and defines no enum; the free-form string is
// translated to Anthropic's `budget_tokens` here:
//   - pure-numeric string (e.g. "4096") → budget_tokens taken literally
//   - "low" / "medium" / "high"         → 1024 / 4096 / 32000 (matches kimi-code)
//   - "none" / "off"                    → thinking disabled (no wire field)
//   - any other value                   → tolerated as "no thinking" rather
//                                         than failing the call; an unknown
//                                        档位 sourced from another provider
//                                         must not break the request.
const BUDGET_LOW = 1024;
const BUDGET_MEDIUM = 4096;
const BUDGET_HIGH = 32000;

const resolveBudgetTokens = (
  effort: string | undefined,
): number | undefined => {
  if (effort === undefined) return undefined;
  if (/^\d+$/.test(effort)) return Number(effort);
  switch (effort) {
    case "low":
      return BUDGET_LOW;
    case "medium":
      return BUDGET_MEDIUM;
    case "high":
      return BUDGET_HIGH;
    case "none":
    case "off":
      return undefined;
    default:
      return undefined;
  }
};

const buildBody = (
  config: AnthropicProviderConfig,
  req: ChatRequest,
): string => {
  const budget = resolveBudgetTokens(req.thinking?.effort);
  const thinkingEnabled = budget !== undefined;

  // max_tokens is required by the Messages API. When thinking is enabled,
  // Anthropic additionally requires max_tokens > budget_tokens; if the
  // caller's cap is at or below the budget, grow it rather than ship a
  // request the API would reject with a 400.
  let maxTokens = req.maxTokens ?? 4096;
  if (thinkingEnabled && maxTokens <= budget) {
    maxTokens = budget + 4096;
  }

  const payload: Record<string, unknown> = {
    model: req.model ?? config.defaultModel,
    messages: messagesToAnthropic(req.messages),
    stream: true,
    max_tokens: maxTokens,
  };
  // System prompt lives at the top level — Anthropic's message list has no
  // system role.
  if (req.system !== undefined && req.system !== "") {
    payload.system = req.system;
  }
  if (thinkingEnabled) {
    payload.thinking = { type: "enabled", budget_tokens: budget };
  }
  // Anthropic's extended-thinking mode forbids temperature; only forward it
  // when thinking is off.
  if (!thinkingEnabled && req.temperature !== undefined) {
    payload.temperature = req.temperature;
  }
  const tools = toolsToAnthropic(req.tools);
  if (tools.length > 0) payload.tools = tools;
  // tool_choice defaults to `auto` on Anthropic's side; we don't send it.
  return JSON.stringify(payload);
};

const fetchCompletion = (
  config: AnthropicProviderConfig,
  req: ChatRequest,
  signal: AbortSignal,
): Effect.Effect<Response, ProviderError> =>
  Effect.tryPromise({
    try: () =>
      niumaFetch(`${config.baseUrl}/v1/messages`, {
        method: "POST",
        headers: headersFor(config.apiKey),
        body: buildBody(config, req),
        signal,
      }),
    catch: (cause) =>
      new Network({ cause: isAbortError(cause) ? undefined : cause }),
  }).pipe(Effect.flatMap(classifyResponse));

const fetchModels = (
  config: AnthropicProviderConfig,
): Effect.Effect<ReadonlyArray<ModelRef>, ProviderError> =>
  Effect.tryPromise({
    try: () =>
      niumaFetch(`${config.baseUrl}/v1/models`, {
        method: "GET",
        headers: headersFor(config.apiKey),
      }),
    catch: (cause) => new Network({ cause }),
  }).pipe(
    Effect.flatMap((res) =>
      res.ok
        ? Effect.promise(() =>
          res.json() as Promise<
            { data?: Array<{ id: string; display_name?: string }> }
          >
        )
        : Effect.fail(new InvalidResponse({ message: `HTTP ${res.status}` })),
    ),
    Effect.map((body) =>
      (body.data ?? []).map((m) => ({
        id: m.id,
        name: m.display_name ?? m.id,
      })),
    ),
    withRetry,
    Effect.catchIf(
      (_e): _e is ProviderError => true,
      () =>
        Effect.succeed<ReadonlyArray<ModelRef>>([
          { id: config.defaultModel, name: config.defaultModel },
        ]),
    ),
  );

// =============================================================================
// Adapter
// =============================================================================
export const makeAnthropicAdapter = (
  config: AnthropicProviderConfig,
): ProviderAdapter => {
  const cfg = normalizeConfig(config);
  return {
    listModels: () => fetchModels(cfg),

    stream: (req: ChatRequest) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const controller = new AbortController();
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              try {
                controller.abort();
              } catch {
                // ignore
              }
            }),
          );
          if (req.abort) {
            if (req.abort.aborted) controller.abort();
            else {
              req.abort.addEventListener(
                "abort",
                () => controller.abort(),
                { once: true },
              );
            }
          }

          const fetched = yield* withRetry(
            fetchCompletion(cfg, req, controller.signal),
            () => controller.signal.aborted,
          ).pipe(
            Effect.catchIf(
              (_e): _e is ProviderError => true,
              (e) =>
                controller.signal.aborted
                  ? Effect.succeed<Response | null>(null)
                  : Effect.fail(e),
            ),
          );
          if (fetched === null) return Stream.empty;
          if (!fetched.body) {
            return Stream.fail(
              new InvalidResponse({
                message: "Streaming response had no body",
              }),
            );
          }
          return Stream.fromAsyncIterable(
            parseAnthropicSSE(fetched.body, controller.signal),
            (e): ProviderError =>
              e instanceof Error && "_tag" in e
                ? (e as ProviderError)
                : new Network({ cause: e }),
          );
        }),
      ),
  };
};

export const AnthropicProviderLive = (
  config: AnthropicProviderConfig,
): Layer.Layer<Provider> =>
  Layer.succeed(
    Provider,
    makeAnthropicAdapter(normalizeConfig(config)),
  );
