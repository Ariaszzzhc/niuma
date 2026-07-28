// ModelCallRecorder is the single path for durable provider-call facts. It
// normalizes optional provider usage without inventing zeroes and records one
// terminal event for agent, subagent, and compaction sampling operations.

import { Effect, Result } from "effect";
import type {
  BillingMode,
  ModelCallActor,
  ModelCallPurpose,
  StopReason,
  Usage,
} from "@niuma/schema";
import type { Usage as ProviderUsage } from "@niuma/provider";
import type { SessionJournal } from "./deps.ts";

export interface ModelCallMetadata {
  readonly journal: SessionJournal;
  readonly sessionId: string;
  readonly turnId: string;
  readonly purpose: ModelCallPurpose;
  readonly actor: ModelCallActor;
  readonly providerId: string;
  readonly modelId: string;
  readonly billingMode: BillingMode;
  readonly now?: () => number;
}

export interface ModelCallOutcome<A> {
  readonly value: A;
  readonly usage?: ProviderUsage;
  readonly finishReason: StopReason;
  readonly attempts: number;
}

export interface RecordedModelCall<A> {
  readonly value: A;
  readonly usage: Usage;
}

export interface ModelCallFailureOptions<E> {
  readonly attempts?: () => number;
  readonly errorMessage: (error: E) => string;
}

export const normalizeProviderUsage = (
  usage?: ProviderUsage,
): Usage => ({
  inputTokens: usage?.promptTokens ?? null,
  outputTokens: usage?.completionTokens ?? null,
  reasoningTokens: usage?.reasoningTokens ?? null,
  cachedInputTokens: usage?.cachedInputTokens ?? null,
  cacheWriteTokens: usage?.cacheWriteTokens ?? null,
});

export const recordModelCall = <A, E>(
  metadata: ModelCallMetadata,
  operation: Effect.Effect<ModelCallOutcome<A>, E>,
  failure: ModelCallFailureOptions<E>,
): Effect.Effect<RecordedModelCall<A>, E> =>
  Effect.gen(function* () {
    const now = metadata.now ?? (() => Date.now());
    const startedAt = now();
    const callId = crypto.randomUUID();
    const result = yield* operation.pipe(Effect.result);
    const durationMs = Math.max(0, now() - startedAt);

    if (Result.isSuccess(result)) {
      const outcome = result.success;
      const usage = normalizeProviderUsage(outcome.usage);
      yield* metadata.journal.append(metadata.sessionId, {
        type: "model.call.completed",
        data: {
          callId,
          turnId: metadata.turnId,
          purpose: metadata.purpose,
          actor: metadata.actor,
          providerId: metadata.providerId,
          modelId: metadata.modelId,
          billingMode: metadata.billingMode,
          durationMs,
          attempts: outcome.attempts,
          finishReason: outcome.finishReason,
          usage,
        },
      });
      return { value: outcome.value, usage };
    }

    yield* metadata.journal.append(metadata.sessionId, {
      type: "model.call.failed",
      data: {
        callId,
        turnId: metadata.turnId,
        purpose: metadata.purpose,
        actor: metadata.actor,
        providerId: metadata.providerId,
        modelId: metadata.modelId,
        billingMode: metadata.billingMode,
        durationMs,
        attempts: failure.attempts?.() ?? 1,
        error: failure.errorMessage(result.failure),
      },
    });
    return yield* Effect.fail(result.failure);
  });
