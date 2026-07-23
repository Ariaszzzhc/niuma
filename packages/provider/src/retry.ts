import { Duration, Effect, Schedule } from "effect";
import { isRetryable, type ProviderError } from "./errors.ts";

export const providerRetrySchedule = Schedule.exponential("500 millis").pipe(
  Schedule.jittered,
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(8))),
  ),
);

export const retryOptions = (isAborted?: () => boolean) => ({
  schedule: providerRetrySchedule,
  while: (e: ProviderError) =>
    isRetryable(e) && !(isAborted?.() ?? false),
  times: 5,
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
