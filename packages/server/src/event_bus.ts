import {
  Deferred,
  Effect,
  Exit,
  PubSub,
  Ref,
  type Scope,
  Stream,
} from "effect";
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
  ) => Effect.Effect<
    Stream.Stream<SseEvent, never, never>,
    never,
    Scope.Scope
  >;
  readonly publish: (event: SseEvent) => Effect.Effect<void, never, never>;
  readonly live: (event: LiveEvent) => Effect.Effect<void, never, never>;
  readonly shutdown: () => Effect.Effect<void, never, never>;
}

const BOUND = 4096;

export const makeEventBus = (): Effect.Effect<EventBus, never, never> =>
  Effect.gen(function* () {
    const logger = log("niuma.server.bus");
    const buses = yield* Ref.make(new Map<string, PubSub.PubSub<SseEvent>>());
    const lastSeqBySession = yield* Ref.make(new Map<string, number>());

    const getOrCreate = (
      sessionId: string,
    ): Effect.Effect<PubSub.PubSub<SseEvent>, never, never> =>
      Effect.gen(function* () {
        const current = yield* Ref.get(buses);
        const cached = current.get(sessionId);
        if (cached) return cached;

        const created = yield* PubSub.bounded<SseEvent>(BOUND);
        const selected = yield* Ref.modify(buses, (m): readonly [
          PubSub.PubSub<SseEvent>,
          Map<string, PubSub.PubSub<SseEvent>>,
        ] => {
          const existing = m.get(sessionId);
          return existing
            ? [existing, m]
            : [created, new Map(m).set(sessionId, created)];
        });
        if (selected !== created) yield* PubSub.shutdown(created);
        return selected;
      });

    const subscribe: EventBus["subscribe"] = (sessionId, fromCursor = 0) =>
      Effect.gen(function* () {
        const ps = yield* getOrCreate(sessionId);
        const subscription = yield* PubSub.subscribe(ps);
        return Stream.fromEffectRepeat(PubSub.take(subscription)).pipe(
          Stream.filter((sse) => sse.cursor >= fromCursor),
        );
      });

    const emit = (sse: SseEvent): Effect.Effect<void, never, never> =>
      Effect.gen(function* () {
        const ps = yield* getOrCreate(sse.event.sessionId);
        const exit = yield* PubSub.publish(ps, sse).pipe(Effect.exit);
        if (Exit.isFailure(exit)) {
          logger.warn("pubsub publish failed: {err}", {
            err: String(exit.cause),
          });
        }
      });

    const publish: EventBus["publish"] = (sse) =>
      Ref.update(lastSeqBySession, (m) => {
        const prev = m.get(sse.event.sessionId) ?? 0;
        return sse.cursor > prev
          ? new Map(m).set(sse.event.sessionId, sse.cursor)
          : m;
      }).pipe(
        Effect.andThen(emit(sse)),
      );

    const live: EventBus["live"] = (event) =>
      Effect.gen(function* () {
        const seqs = yield* Ref.get(lastSeqBySession);
        yield* emit({ cursor: seqs.get(event.sessionId) ?? 0, event });
      });

    const shutdown: EventBus["shutdown"] = () =>
      Effect.gen(function* () {
        const m = yield* Ref.get(buses);
        for (const ps of m.values()) yield* PubSub.shutdown(ps);
      });

    return { subscribe, publish, live, shutdown } satisfies EventBus;
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
