import { assertEquals } from "@std/assert";
import { Effect, Stream } from "effect";
import type { RecordedEvent, SseEvent } from "@niuma/schema";
import { makeEventBus } from "../src/event_bus.ts";
import { makeKernel } from "../src/kernel.ts";
import type { SessionStore } from "../src/session_store.ts";

Deno.test("kernel event stream buffers the replay-to-live handoff without reordering", async () => {
  const replayStarted = Promise.withResolvers<void>();
  const releaseReplay = Promise.withResolvers<void>();
  const initial = {
    seq: 1,
    ts: 1,
    sessionId: "session",
    type: "session.created",
    data: {
      workspace: "/tmp",
      model: "mock",
      mcpServers: [],
    },
  } satisfies RecordedEvent;

  let seq = 1;
  const store: SessionStore = {
    workspace: "/tmp",
    sessionsDir: "/tmp/sessions",
    append: (input) =>
      Promise.resolve({
        ...input,
        seq: ++seq,
        ts: input.ts ?? seq,
      } as RecordedEvent),
    replay: async function* (_sessionId, fromSeq = 0) {
      if (initial.seq >= fromSeq) yield initial;
      replayStarted.resolve();
      await releaseReplay.promise;
    },
    read: () => Promise.resolve([initial]),
    state: () => Promise.resolve(undefined),
    listRecent: () => Promise.resolve([]),
    listIds: () => Promise.resolve(["session"]),
    lastSeq: () => Promise.resolve(1),
    touch: () => Promise.resolve(true),
    remove: () => Promise.resolve(),
    removeOlderThan: () => Promise.resolve(false),
    pathFor: (sessionId) => `/tmp/sessions/${sessionId}.jsonl`,
  };
  const bus = await Effect.runPromise(makeEventBus());
  const kernel = await Effect.runPromise(
    makeKernel({ store, bus }),
  );

  const collecting = Effect.runPromise(
    kernel.events("session", 0).pipe(
      Stream.take(3),
      Stream.runCollect,
    ),
  );
  await replayStarted.promise;

  await Effect.runPromise(kernel.append({
    sessionId: "session",
    type: "user.message",
    data: { parts: [{ type: "text", text: "during replay" }] },
  }));
  await Effect.runPromise(kernel.live({
    sessionId: "session",
    ts: 2,
    type: "text.delta",
    data: { delta: "streamed" },
  }));
  releaseReplay.resolve();

  try {
    const events = Array.from(await collecting);
    assertEquals(events.map((event) => event.cursor), [1, 2, 2]);
    assertEquals(events.map((event) => event.event.type), [
      "session.created",
      "user.message",
      "text.delta",
    ]);
  } finally {
    await Effect.runPromise(bus.shutdown());
  }
});

Deno.test("event bus shares one channel across concurrent first subscribers", async () => {
  const bus = await Effect.runPromise(makeEventBus());
  const event = {
    cursor: 1,
    event: {
      seq: 1,
      ts: 1,
      sessionId: "new-session",
      type: "session.created",
      data: {
        workspace: "/tmp",
        model: "mock",
        mcpServers: [],
      },
    },
  } satisfies SseEvent;

  try {
    const received = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const streams = yield* Effect.all(
            Array.from(
              { length: 32 },
              () => bus.subscribe("new-session"),
            ),
            { concurrency: "unbounded" },
          );
          yield* bus.publish(event);
          return yield* Effect.all(
            streams.map((stream) =>
              stream.pipe(Stream.take(1), Stream.runCollect)
            ),
            { concurrency: "unbounded" },
          );
        }).pipe(Effect.timeout("1 second")),
      ),
    );
    assertEquals(
      received.map((events) => Array.from(events, (item) => item.cursor)),
      Array.from({ length: 32 }, () => [1]),
    );
  } finally {
    await Effect.runPromise(bus.shutdown());
  }
});
