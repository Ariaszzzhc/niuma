// ModelCallRecorder contract tests. Every provider sampling operation records
// exactly one terminal, content-free fact and never turns missing usage into
// a false zero.

import { assertEquals } from "@std/assert";
import { Effect, Exit } from "effect";
import type { RecordedEvent } from "@niuma/schema";
import type { EventInput, SessionJournal } from "../src/deps.ts";
import { normalizeProviderUsage, recordModelCall } from "../src/model_call.ts";

const makeLog = (): SessionJournal & { readonly events: RecordedEvent[] } => {
  const events: RecordedEvent[] = [];
  return {
    events,
    append: (sessionId: string, input: EventInput) =>
      Effect.sync(() => {
        const event = {
          seq: events.length,
          ts: 1_000 + events.length,
          sessionId,
          ...input,
        } as RecordedEvent;
        events.push(event);
        return event;
      }),
    replay: () => Effect.succeed([...events]),
  };
};

const metadata = (journal: SessionJournal, now?: () => number) => ({
  journal,
  sessionId: "session-1",
  turnId: "turn-1",
  purpose: "agent" as const,
  actor: "subagent" as const,
  providerId: "openai",
  modelId: "gpt-5",
  billingMode: "subscription" as const,
  ...(now !== undefined ? { now } : {}),
});

Deno.test("ModelCallRecorder preserves rich usage and durable call metadata", async () => {
  const log = makeLog();
  const times = [100, 145];
  const result = await Effect.runPromise(
    recordModelCall(
      metadata(log, () => times.shift()!),
      Effect.succeed({
        value: "answer",
        finishReason: "stop" as const,
        attempts: 3,
        usage: {
          promptTokens: 120,
          completionTokens: 30,
          reasoningTokens: 11,
          cachedInputTokens: 80,
          cacheWriteTokens: 9,
        },
      }),
      { errorMessage: String },
    ),
  );

  assertEquals(result.value, "answer");
  assertEquals(result.usage, {
    inputTokens: 120,
    outputTokens: 30,
    reasoningTokens: 11,
    cachedInputTokens: 80,
    cacheWriteTokens: 9,
  });
  assertEquals(log.events.length, 1);
  const event = log.events[0];
  if (event.type !== "model.call.completed") {
    throw new Error(`unexpected event: ${event.type}`);
  }
  assertEquals(event.data.turnId, "turn-1");
  assertEquals(event.data.purpose, "agent");
  assertEquals(event.data.actor, "subagent");
  assertEquals(event.data.providerId, "openai");
  assertEquals(event.data.modelId, "gpt-5");
  assertEquals(event.data.billingMode, "subscription");
  assertEquals(event.data.durationMs, 45);
  assertEquals(event.data.attempts, 3);
});

Deno.test("ModelCallRecorder represents omitted provider usage as unknown", () => {
  assertEquals(normalizeProviderUsage(), {
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    cachedInputTokens: null,
    cacheWriteTokens: null,
  });
});

Deno.test("ModelCallRecorder emits one failed fact with the observed attempts", async () => {
  const log = makeLog();
  const exit = await Effect.runPromiseExit(
    recordModelCall(
      metadata(log),
      Effect.fail("network exhausted"),
      {
        attempts: () => 5,
        errorMessage: (error) => error,
      },
    ),
  );

  assertEquals(Exit.isFailure(exit), true);
  assertEquals(log.events.length, 1);
  const event = log.events[0];
  if (event.type !== "model.call.failed") {
    throw new Error(`unexpected event: ${event.type}`);
  }
  assertEquals(event.data.attempts, 5);
  assertEquals(event.data.error, "network exhausted");
});
