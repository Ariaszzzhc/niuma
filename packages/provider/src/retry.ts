import { Duration, Effect, Schedule } from "effect";
import { isRetryable, type ProviderError } from "./errors.ts";

export const providerRetrySchedule: Schedule.Schedule<Duration.Duration> =
  Schedule.exponential("500 millis").pipe(
    Schedule.jittered,
    Schedule.modifyDelay(({ duration }) =>
      Effect.succeed(Duration.min(duration, Duration.seconds(8)))
    ),
  );

export const retryOptions = (
  isAborted?: () => boolean,
): Effect.Retry.Options<ProviderError> => ({
  schedule: providerRetrySchedule,
  while: (e: ProviderError) => isRetryable(e) && !(isAborted?.() ?? false),
  // effect@4 gates retries 1..`times` (`Schedule.while(attempt <= times)`),
  // and the source effect always runs once before the policy applies, so
  // `times` here is RETRIES, not total attempts. times: 4 → 5 total transport
  // attempts (1 initial + 4 retries), matching STREAM_MAX_RETRIES's documented
  // "5 total samples" convention so the transport and stream layers agree on
  // their budget.
  times: 4,
});

export const withRetry = <A, R>(
  eff: Effect.Effect<A, ProviderError, R>,
  isAborted?: () => boolean,
): Effect.Effect<A, ProviderError, R> =>
  eff.pipe(Effect.retry(retryOptions(isAborted)));

// Mid-stream retry budget for the agent loop's stream layer (codex-style layer
// 2). This complements the transport-layer `withRetry` above, which only wraps
// the initial fetch. Retries after the initial attempt: 4 (5 total samples).
// Distinct from providerRetrySchedule on purpose — different base/budget.
export const STREAM_MAX_RETRIES = 4;
