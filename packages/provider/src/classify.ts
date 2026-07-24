import { Effect } from "effect";
import {
  AuthFailed,
  ContextOverflow,
  InvalidResponse,
  Overloaded,
  RateLimited,
  type ProviderError,
} from "./errors.ts";

// Shared HTTP-status -> ProviderError ladder for every fetch-based adapter.
// Extracted verbatim from openai.ts so the Responses adapter classifies
// identically: the error taxonomy IS the contract surface that withRetry and
// the agent loop branch on, so divergent mappings between adapters would
// fragment retry/recovery behaviour. The ladder:
//   401 / 403        -> AuthFailed
//   429              -> RateLimited (retry-after honoured when numeric)
//   >= 500           -> Overloaded (transient, retryable)
//   400 + context-ish -> ContextOverflow
//   anything else    -> InvalidResponse
// Anthropic's 529 "overloaded" status falls in the >= 500 band, so the same
// ladder covers both protocols without a special case.
export const classifyResponse = (
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
