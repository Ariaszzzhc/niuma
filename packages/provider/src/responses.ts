import { Effect, Stream } from "effect";
import { niumaFetch } from "./http.ts";
import type { ProviderAdapter } from "./contract.ts";
import type { ChatRequest, ModelRef } from "./domain.ts";
import {
  type AuthFailed,
  InvalidResponse,
  Network,
  type ProviderError,
} from "./errors.ts";
import { withRetry } from "./retry.ts";
import { classifyResponse } from "./classify.ts";
import { messagesToResponses, toolsToResponses } from "./responses_convert.ts";
import { parseResponsesSSE } from "./responses_sse.ts";

// NOTE: this package deliberately knows nothing about where configuration or
// credentials come from. OAuth tokens arrive via the injected OAuthTokenSource
// (implemented server-side, the ONLY place refreshTokens + setAuth + the
// in-memory cache meet); an API key arrives as a plain string. No Deno.env
// reads, no file reads, no auth.json access here (design rule 4).

/** The ChatGPT-subscription OAuth rewrite target. When `oauth` credentials are
 * present the adapter rewrites `{baseUrl}/responses` to this URL. Lives in the
 * provider package because it is wire-protocol knowledge, not configuration. */
export const CODEX_BACKEND_URL =
  "https://chatgpt.com/backend-api/codex/responses";

/** Proactive + single-flight access-token provider, injected by the server.
 * Effect-typed so refresh failures surface as AuthFailed, not rejects.
 * Implementations (server lane) guarantee: at most one refresh in flight per
 * provider id; a token expiring within OAUTH_EXPIRY_SKEW_MS is refreshed
 * before return. `invalidateAndRefresh` is the 401-recovery path: discard the
 * cached token and refresh immediately (still single-flight). */
export interface OAuthTokenSource {
  readonly getAccessToken: () => Effect.Effect<
    { readonly accessToken: string; readonly accountId?: string },
    AuthFailed
  >;
  readonly invalidateAndRefresh: () => Effect.Effect<
    { readonly accessToken: string; readonly accountId?: string },
    AuthFailed
  >;
}

export interface ResponsesAdapterConfig {
  // Default RESPONSES_DEFAULT_BASE_URL when the caller (bootstrap) leaves it
  // unset; only the {baseUrl}/responses path is used for the apiKey kind.
  readonly baseUrl: string;
  readonly defaultModel: string;
  readonly auth:
    | { readonly kind: "apiKey"; readonly key: string }
    | { readonly kind: "oauth"; readonly tokenSource: OAuthTokenSource };
}

const trimUrl = (u: string): string => u.replace(/\/+$/, "");

export const normalizeConfig = (
  config: ResponsesAdapterConfig,
): ResponsesAdapterConfig => ({ ...config, baseUrl: trimUrl(config.baseUrl) });

const isAbortError = (e: unknown): boolean =>
  e instanceof Error &&
  (e.name === "AbortError" || e.name === "TimeoutError");

// =============================================================================
// Request body
// =============================================================================
const buildBody = (
  config: ResponsesAdapterConfig,
  req: ChatRequest,
  oauth: boolean,
): string => {
  const payload: Record<string, unknown> = {
    model: req.model ?? config.defaultModel,
    // System prompt lives in the Responses `instructions` field, NOT as a
    // system-role input item (the ChatGPT codex backend rejects system items;
    // api.openai.com accepts them but `instructions` is the documented home).
    ...(req.system !== undefined && req.system !== ""
      ? { instructions: req.system }
      : {}),
    input: messagesToResponses(req.messages),
    // store:false is FORCED for BOTH auth kinds - niuma never asks the Responses
    // API to retain conversation state server-side. Replay is client-side via
    // the input list + encrypted reasoning items.
    store: false,
    stream: true,
  };
  const tools = toolsToResponses(req.tools);
  if (tools.length > 0) payload.tools = tools;
  if (req.maxTokens !== undefined) payload.max_output_tokens = req.maxTokens;
  if (req.temperature !== undefined) payload.temperature = req.temperature;
  // Effort passes through VERBATIM to reasoning.effort - no enum, no mapping,
  // no family table (design rule 2). The legal档位 are an OpenAI protocol
  // concern; invalid values surface as a 400 via classifyResponse.
  if (req.thinking?.effort !== undefined) {
    payload.reasoning = { effort: req.thinking.effort };
  }
  // Encrypted reasoning replay is a Responses extension opted into via
  // `include`. Requested for the oauth kind only: the codex backend requires
  // it to return encrypted_content for round-tripping reasoning across turns;
  // an api.openai.com apiKey caller does not need the flag here. store:false
  // above applies to both kinds regardless.
  if (oauth) {
    payload.include = ["reasoning.encrypted_content"];
  }
  return JSON.stringify(payload);
};

// =============================================================================
// Headers
// =============================================================================
const headersForApiKey = (key: string): Record<string, string> => ({
  "content-type": "application/json",
  authorization: `Bearer ${key}`,
});

const headersForOauth = (
  accessToken: string,
  accountId: string | undefined,
): Record<string, string> => ({
  "content-type": "application/json",
  authorization: `Bearer ${accessToken}`,
  // The codex backend requires the Beta header to opt into the Responses
  // surface on the ChatGPT subscription path.
  "openai-beta": "responses=experimental",
  // ChatGPT-Account-Id scopes the request to the subscription's account;
  // omitted when accountId could not be extracted from the JWT (the backend
  // falls back to the token's default account).
  ...(accountId !== undefined ? { "chatgpt-account-id": accountId } : {}),
});

// =============================================================================
// Fetch
// =============================================================================
const endpointUrl = (config: ResponsesAdapterConfig, oauth: boolean): string =>
  // OAuth-backed traffic is rewritten wholesale to the codex backend
  // ({baseUrl} is ignored - the ChatGPT subscription path ignores the
  // api.openai.com host). The apiKey kind posts to {baseUrl}/responses.
  oauth ? CODEX_BACKEND_URL : `${config.baseUrl}/responses`;

const fetchOnce = (
  config: ResponsesAdapterConfig,
  req: ChatRequest,
  signal: AbortSignal,
  route: { readonly url: string; readonly headers: HeadersInit },
): Effect.Effect<Response, ProviderError> => {
  const oauth = config.auth.kind === "oauth";
  return Effect.tryPromise({
    try: () =>
      niumaFetch(route.url, {
        method: "POST",
        headers: route.headers,
        body: buildBody(config, req, oauth),
        signal,
      }),
    catch: (cause) =>
      new Network({ cause: isAbortError(cause) ? undefined : cause }),
  }).pipe(Effect.flatMap(classifyResponse));
};

const fetchCompletion = (
  config: ResponsesAdapterConfig,
  req: ChatRequest,
  signal: AbortSignal,
): Effect.Effect<Response, ProviderError> => {
  if (config.auth.kind === "apiKey") {
    return fetchOnce(config, req, signal, {
      url: endpointUrl(config, false),
      headers: headersForApiKey(config.auth.key),
    });
  }
  // OAuth: resolve a token, POST, and on AuthFailed (401 from the POST or a
  // refresh failure surfacing from getAccessToken) invalidate+refresh exactly
  // once and retry the POST. The retry is bounded to one - a second AuthFailed
  // propagates (withRetry above this layer does not retry AuthFailed, so the
  // whole stream fails with AuthFailed after the single recovery attempt).
  const { tokenSource } = config.auth;
  const post = (tok: { accessToken: string; accountId?: string }) =>
    fetchOnce(config, req, signal, {
      url: endpointUrl(config, true),
      headers: headersForOauth(tok.accessToken, tok.accountId),
    });
  return tokenSource.getAccessToken().pipe(
    Effect.flatMap(post),
    Effect.catchIf(
      (e): e is AuthFailed => e._tag === "AuthFailed",
      () => tokenSource.invalidateAndRefresh().pipe(Effect.flatMap(post)),
    ),
  );
};

// =============================================================================
// listModels
// =============================================================================
const fetchModels = (
  config: ResponsesAdapterConfig,
): Effect.Effect<ReadonlyArray<ModelRef>, ProviderError> => {
  if (config.auth.kind === "oauth") {
    // The ChatGPT codex backend exposes no model catalogue; return the
    // configured default so resolveModelRef/listModels callers always see at
    // least one model (same fallback shape as openai.ts's catch-all).
    return Effect.succeed<ModelRef[]>([
      { id: config.defaultModel, name: config.defaultModel },
    ]);
  }
  // Extract the key after the oauth early-return narrows the auth union, so the
  // tryPromise closure below captures a plain string (TS does not carry the
  // kind-narrowing of a parameter into nested function closures).
  const key = config.auth.key;
  return Effect.tryPromise({
    try: () =>
      niumaFetch(`${config.baseUrl}/models`, {
        method: "GET",
        headers: headersForApiKey(key),
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
        Effect.succeed<ModelRef[]>([
          { id: config.defaultModel, name: config.defaultModel },
        ]),
    ),
  );
};

// =============================================================================
// Adapter
// =============================================================================
export const makeResponsesAdapter = (
  config: ResponsesAdapterConfig,
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
            parseResponsesSSE(fetched.body, controller.signal),
            (e): ProviderError =>
              e instanceof Error && "_tag" in e
                ? (e as ProviderError)
                : new Network({ cause: e }),
          );
        }),
      ),
  };
};
