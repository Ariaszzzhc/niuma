import { Effect, Layer, Stream } from "effect";
import { niumaFetch } from "./http.ts";
import { Provider, type ProviderAdapter } from "./contract.ts";
import type { ChatRequest, ModelRef } from "./domain.ts";
import {
  type AuthFailed,
  InvalidResponse,
  Network,
  type ProviderError,
} from "./errors.ts";
import { withRetry } from "./retry.ts";
import { messagesToOpenAI, toolsToOpenAI } from "./convert.ts";
import { parseOpenAISSE } from "./sse.ts";
// Shared with responses.ts: the HTTP -> ProviderError ladder is the contract
// surface withRetry and the agent loop branch on, so both fetch-based adapters
// classify identically (extracted verbatim into its own module).
import { classifyResponse } from "./classify.ts";
import type { OAuthTokenSource } from "./responses.ts";

export interface OpenAIProviderConfig {
  readonly baseUrl: string;
  readonly defaultModel: string;
  readonly auth:
    | { readonly kind: "apiKey"; readonly key: string }
    | { readonly kind: "oauth"; readonly tokenSource: OAuthTokenSource };
}

// NOTE: this package deliberately knows nothing about where configuration
// comes from. Credentials/endpoints are loaded by @niuma/config (config.toml
// + auth.json) and passed in explicitly by the caller (server bootstrap):
// an API key arrives as a plain string, an OAuth credential as an injected
// OAuthTokenSource (same seam as responses.ts — refresh/persistence live
// server-side). No Deno.env reads here.

const trimUrl = (u: string): string => u.replace(/\/+$/, "");

export const normalizeConfig = (
  config: OpenAIProviderConfig,
): OpenAIProviderConfig => ({ ...config, baseUrl: trimUrl(config.baseUrl) });

const isAbortError = (e: unknown): boolean =>
  e instanceof Error &&
  (e.name === "AbortError" || e.name === "TimeoutError");

const headersFor = (token: string): HeadersInit => ({
  "content-type": "application/json",
  authorization: `Bearer ${token}`,
});

const buildBody = (config: OpenAIProviderConfig, req: ChatRequest): string => {
  const domain = req.system
    ? [
      { role: "system" as const, content: req.system },
      ...messagesToOpenAI(req.messages),
    ]
    : messagesToOpenAI(req.messages);
  const payload: Record<string, unknown> = {
    model: req.model ?? config.defaultModel,
    messages: domain,
    stream: true,
    stream_options: { include_usage: true },
  };
  const tools = toolsToOpenAI(req.tools);
  if (tools.length > 0) payload.tools = tools;
  if (req.maxTokens !== undefined) payload.max_tokens = req.maxTokens;
  if (req.temperature !== undefined) payload.temperature = req.temperature;
  // Pass effort through verbatim as the top-level OpenAI reasoning_effort. The
  // legal档位 (none/minimal/low/medium/high/xhigh/max) are an OpenAI protocol
  // concern; niuma does no mapping, and invalid values are surfaced as a 400 by
  // classifyResponse above.
  if (req.thinking?.effort !== undefined) {
    payload.reasoning_effort = req.thinking.effort;
  }
  return JSON.stringify(payload);
};

const fetchOnce = (
  config: OpenAIProviderConfig,
  req: ChatRequest,
  signal: AbortSignal,
  token: string,
): Effect.Effect<Response, ProviderError> =>
  Effect.tryPromise({
    try: () =>
      niumaFetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: headersFor(token),
        body: buildBody(config, req),
        signal,
      }),
    catch: (cause) =>
      new Network({ cause: isAbortError(cause) ? undefined : cause }),
  }).pipe(Effect.flatMap(classifyResponse));

const fetchCompletion = (
  config: OpenAIProviderConfig,
  req: ChatRequest,
  signal: AbortSignal,
): Effect.Effect<Response, ProviderError> => {
  if (config.auth.kind === "apiKey") {
    return fetchOnce(config, req, signal, config.auth.key);
  }
  // OAuth: resolve a token per request (the source refreshes proactively),
  // POST, and on AuthFailed (401 from the POST or a refresh failure surfacing
  // from getAccessToken) invalidate+refresh exactly once and retry — the
  // bounded recovery ladder is identical to responses.ts. No endpoint rewrite
  // and no ChatGPT-specific headers here: the token is a plain Bearer against
  // {baseUrl}/chat/completions (e.g. the Kimi coding endpoint).
  const { tokenSource } = config.auth;
  const post = (tok: { accessToken: string }) =>
    fetchOnce(config, req, signal, tok.accessToken);
  return tokenSource.getAccessToken().pipe(
    Effect.flatMap(post),
    Effect.catchIf(
      (e): e is AuthFailed => e._tag === "AuthFailed",
      () => tokenSource.invalidateAndRefresh().pipe(Effect.flatMap(post)),
    ),
  );
};

const fetchModelsWith = (
  config: OpenAIProviderConfig,
  token: string,
): Effect.Effect<ReadonlyArray<ModelRef>, ProviderError> =>
  Effect.tryPromise({
    try: () =>
      niumaFetch(`${config.baseUrl}/models`, {
        method: "GET",
        headers: headersFor(token),
      }),
    catch: (cause) => new Network({ cause }),
  }).pipe(
    Effect.flatMap((res) =>
      res.ok
        ? Effect.promise(() =>
          res.json() as Promise<{ data?: Array<{ id: string }> }>
        )
        : Effect.fail(new InvalidResponse({ message: `HTTP ${res.status}` }))
    ),
    Effect.map((body) =>
      (body.data ?? []).map((m) => ({ id: m.id, name: m.id }))
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

const fetchModels = (
  config: OpenAIProviderConfig,
): Effect.Effect<ReadonlyArray<ModelRef>, ProviderError> => {
  if (config.auth.kind === "apiKey") {
    return fetchModelsWith(config, config.auth.key);
  }
  // The Kimi coding endpoint exposes /models under the same Bearer token;
  // fetchModelsWith's catch-all still falls back to the default model when
  // the listing fails (including a token-source AuthFailed).
  return config.auth.tokenSource.getAccessToken().pipe(
    Effect.flatMap((tok) => fetchModelsWith(config, tok.accessToken)),
  );
};

export const makeOpenAIAdapter = (
  config: OpenAIProviderConfig,
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
            })
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
            parseOpenAISSE(fetched.body, controller.signal),
            (e): ProviderError =>
              e instanceof Error && "_tag" in e
                ? (e as ProviderError)
                : new Network({ cause: e }),
          );
        }),
      ),
  };
};

export const OpenAIProviderLive = (
  config: OpenAIProviderConfig,
): Layer.Layer<Provider> =>
  Layer.succeed(
    Provider,
    makeOpenAIAdapter(normalizeConfig(config)),
  );
