import { Effect, Layer, Stream } from "effect";
import { Provider, type ProviderAdapter } from "./contract.ts";
import type { ChatRequest, ModelRef } from "./domain.ts";
import {
  AuthFailed,
  ContextOverflow,
  InvalidResponse,
  Network,
  Overloaded,
  RateLimited,
  type ProviderError,
} from "./errors.ts";
import { withRetry } from "./retry.ts";
import { messagesToOpenAI, toolsToOpenAI } from "./convert.ts";
import { parseOpenAISSE } from "./sse.ts";

export interface OpenAIProviderConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly defaultModel: string;
}

// NOTE: this package deliberately knows nothing about where configuration
// comes from. Credentials/endpoints are loaded by @niuma/config (config.toml
// + auth.json) and passed in explicitly by the caller (server bootstrap).
// No Deno.env reads here.

const trimUrl = (u: string): string => u.replace(/\/+$/, "");

export const normalizeConfig = (
  config: OpenAIProviderConfig,
): OpenAIProviderConfig => ({ ...config, baseUrl: trimUrl(config.baseUrl) });

const isAbortError = (e: unknown): boolean =>
  e instanceof Error &&
  (e.name === "AbortError" || e.name === "TimeoutError");

const headersFor = (apiKey: string): HeadersInit => ({
  "content-type": "application/json",
  authorization: `Bearer ${apiKey}`,
});

const buildBody = (config: OpenAIProviderConfig, req: ChatRequest): string => {
  const domain = req.system
    ? [{ role: "system" as const, content: req.system }, ...messagesToOpenAI(req.messages)]
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
  return JSON.stringify(payload);
};

const classifyResponse = (
  res: Response,
): Effect.Effect<Response, ProviderError> =>
  Effect.gen(function* () {
    if (res.ok) return res;
    const text = yield* Effect.promise(() => res.text().catch(() => ""));
    const msg = text || res.statusText;
    const status = res.status;
    if (status === 401 || status === 403) {
      return yield* Effect.fail(new AuthFailed({ message: msg }));
    }
    if (status === 429) {
      const ra = res.headers.get("retry-after");
      let retryAfterMs: number | undefined;
      if (ra) {
        const secs = Number(ra);
        if (Number.isFinite(secs)) retryAfterMs = secs * 1000;
      }
      return yield* Effect.fail(
        retryAfterMs !== undefined
          ? new RateLimited({ retryAfterMs })
          : new RateLimited({}),
      );
    }
    if (status >= 500) {
      return yield* Effect.fail(new Overloaded({ message: msg }));
    }
    if (status === 400 && /context|too long|maximum|token/i.test(msg)) {
      return yield* Effect.fail(new ContextOverflow({ message: msg }));
    }
    return yield* Effect.fail(
      new InvalidResponse({ message: `HTTP ${status}: ${msg}` }),
    );
  });

const fetchCompletion = (
  config: OpenAIProviderConfig,
  req: ChatRequest,
  signal: AbortSignal,
): Effect.Effect<Response, ProviderError> =>
  Effect.tryPromise({
    try: () =>
      fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: headersFor(config.apiKey),
        body: buildBody(config, req),
        signal,
      }),
    catch: (cause) => new Network({ cause: isAbortError(cause) ? undefined : cause }),
  }).pipe(Effect.flatMap(classifyResponse));

const fetchModels = (
  config: OpenAIProviderConfig,
): Effect.Effect<ReadonlyArray<ModelRef>, ProviderError> =>
  Effect.tryPromise({
    try: () =>
      fetch(`${config.baseUrl}/models`, {
        method: "GET",
        headers: headersFor(config.apiKey),
      }),
    catch: (cause) => new Network({ cause }),
  }).pipe(
    Effect.flatMap((res) =>
      res.ok
        ? Effect.promise(() =>
          res.json() as Promise<{ data?: Array<{ id: string }> }>
        )
        : Effect.fail(new InvalidResponse({ message: `HTTP ${res.status}` })),
    ),
    Effect.map((body) =>
      (body.data ?? []).map((m) => ({ id: m.id, name: m.id })),
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
            new InvalidResponse({ message: "Streaming response had no body" }),
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
