import { Deferred, Effect, Exit, PubSub, Ref, Stream } from "effect";
import type {
  ApprovalRequestedData,
  ApprovalResolvedData,
  LiveEvent,
  SseEvent,
} from "@niuma/schema";
import { log } from "./logger.ts";

export interface EventBus {
  readonly subscribe: (
    sessionId: string,
    fromCursor?: number,
  ) => Stream.Stream<SseEvent, never, never>;
  readonly publish: (event: SseEvent) => Effect.Effect<void, never, never>;
  readonly live: (event: LiveEvent) => Effect.Effect<void, never, never>;
  readonly lastSeq: (sessionId: string) => Effect.Effect<number, never, never>;
  readonly shutdown: () => Effect.Effect<void, never, never>;
}

const BOUND = 4096;

export const makeEventBus = (
  logPath?: string,
): Effect.Effect<EventBus, never, never> =>
  Effect.gen(function* () {
    const logger = log("niuma.server.bus");
    const buses = yield* Ref.make(new Map<string, PubSub.PubSub<SseEvent>>());
    const liveBuses = yield* Ref.make(
      new Map<string, PubSub.PubSub<LiveEvent>>(),
    );
    const lastSeqBySession = yield* Ref.make(new Map<string, number>());

    const getOrCreate = (
      sessionId: string,
    ): Effect.Effect<PubSub.PubSub<SseEvent>, never, never> =>
      Effect.gen(function* () {
        const m = yield* Ref.get(buses);
        const existing = m.get(sessionId);
        if (existing) return existing;
        const created = yield* PubSub.bounded<SseEvent>(BOUND);
        yield* Ref.update(buses, (mm) => new Map(mm).set(sessionId, created));
        return created;
      });

    const getOrCreateLive = (
      sessionId: string,
    ): Effect.Effect<PubSub.PubSub<LiveEvent>, never, never> =>
      Effect.gen(function* () {
        const m = yield* Ref.get(liveBuses);
        const existing = m.get(sessionId);
        if (existing) return existing;
        const created = yield* PubSub.bounded<LiveEvent>(BOUND);
        yield* Ref.update(
          liveBuses,
          (mm) => new Map(mm).set(sessionId, created),
        );
        return created;
      });

    const subscribe: EventBus["subscribe"] = (sessionId, fromCursor = 0) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const ps = yield* getOrCreate(sessionId);
          const recorded = Stream.fromPubSub(ps).pipe(
            Stream.filter((sse) => sse.cursor >= fromCursor),
          );
          // Live-only events (text.delta / tool.progress / text.reset) ride
          // the same subscription stream. They have no seq, so their cursor
          // repeats the last recorded seq — consumers must treat a repeated
          // cursor as live, never as a resumable position. Without this merge
          // the live PubSub had no readers at all and the SSE consumer only
          // saw recorded events — the text appeared in one shot at
          // assistant.message instead of streaming.
          const livePs = yield* getOrCreateLive(sessionId);
          const liveStream = Stream.fromPubSub(livePs).pipe(
            Stream.map((event) => ({ cursor: fromCursor - 1, event })),
          );
          return Stream.merge(recorded, liveStream);
        }),
      );

    const publish: EventBus["publish"] = (sse) =>
      Effect.gen(function* () {
        yield* Ref.update(lastSeqBySession, (m) => {
          const prev = m.get(sse.event.sessionId) ?? 0;
          if (sse.cursor > prev) {
            return new Map(m).set(sse.event.sessionId, sse.cursor);
          }
          return m;
        });
        const ps = yield* getOrCreate(sse.event.sessionId);
        const exit = yield* PubSub.publish(ps, sse).pipe(Effect.exit);
        if (Exit.isFailure(exit)) {
          logger.warn("pubsub publish failed: {err}", {
            err: String(exit.cause),
          });
        }
      });

    const live: EventBus["live"] = (event) =>
      Effect.gen(function* () {
        const ps = yield* getOrCreateLive(event.sessionId);
        const exit = yield* PubSub.publish(ps, event).pipe(Effect.exit);
        if (Exit.isFailure(exit)) {
          logger.warn("pubsub live publish failed: {err}", {
            err: String(exit.cause),
          });
        }
      });

    const lastSeq: EventBus["lastSeq"] = (sessionId) =>
      Ref.get(lastSeqBySession).pipe(
        Effect.map((m) => m.get(sessionId) ?? 0),
      );

    const shutdown: EventBus["shutdown"] = () =>
      Effect.gen(function* () {
        const m = yield* Ref.get(buses);
        for (const ps of m.values()) yield* PubSub.shutdown(ps);
        const lm = yield* Ref.get(liveBuses);
        for (const ps of lm.values()) yield* PubSub.shutdown(ps);
      });

    if (logPath) {
      logger.debug("eventbus initialized ({path})", { path: logPath });
    }

    return { subscribe, publish, live, lastSeq, shutdown } satisfies EventBus;
  });

export interface PendingApproval {
  readonly approvalId: string;
  readonly deferred: Deferred.Deferred<ApprovalResolvedData, never>;
  readonly request: ApprovalRequestedData;
}

export interface ApprovalRegistry {
  readonly register: (
    request: ApprovalRequestedData,
  ) => Effect.Effect<
    Deferred.Deferred<ApprovalResolvedData, never>,
    never,
    never
  >;
  readonly resolve: (
    approvalId: string,
    decision: ApprovalResolvedData,
  ) => Effect.Effect<boolean, never, never>;
  readonly remove: (
    approvalId: string,
  ) => Effect.Effect<boolean, never, never>;
  readonly pending: () => Effect.Effect<
    ReadonlyArray<PendingApproval>,
    never,
    never
  >;
}

export const makeApprovalRegistry = (): Effect.Effect<
  ApprovalRegistry,
  never,
  never
> =>
  Effect.gen(function* () {
    const registry = yield* Ref.make(new Map<string, PendingApproval>());

    const register: ApprovalRegistry["register"] = (request) =>
      Effect.gen(function* () {
        const d = yield* Deferred.make<ApprovalResolvedData, never>();
        const entry: PendingApproval = {
          approvalId: request.approvalId,
          deferred: d,
          request,
        };
        yield* Ref.update(registry, (m) =>
          new Map(m).set(request.approvalId, entry));
        return d;
      });

    const resolve: ApprovalRegistry["resolve"] = (approvalId, decision) =>
      Effect.gen(function* () {
        const m = yield* Ref.get(registry);
        const entry = m.get(approvalId);
        if (!entry) {
          return false;
        }
        yield* Deferred.succeed(entry.deferred, decision);
        yield* Ref.update(registry, (mm) => {
          const next = new Map(mm);
          next.delete(approvalId);
          return next;
        });
        return true;
      });

    const pending: ApprovalRegistry["pending"] = () =>
      Ref.get(registry).pipe(Effect.map((m) =>
        Array.from(m.values())
      ));

    const remove: ApprovalRegistry["remove"] = (approvalId) =>
      Ref.modify(registry, (m) => {
        if (!m.has(approvalId)) return [false, m];
        const next = new Map(m);
        next.delete(approvalId);
        return [true, next];
      });

    return { register, resolve, remove, pending } satisfies ApprovalRegistry;
  });
