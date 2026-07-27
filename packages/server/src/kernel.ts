import { Context, Deferred, Effect, Ref, type Scope, Stream } from "effect";
import {
  type ApprovalRequestedData,
  type ApprovalResolvedData,
  type LiveEvent,
  type RecordedEvent,
  SCHEMA_VERSION,
  type SseEvent,
} from "@niuma/schema";
import { type ApprovalRegistry, makeApprovalRegistry } from "./event_bus.ts";
import type { EventLog } from "./event_log.ts";
import type { Projection } from "./projection.ts";

const defaultNow = (): number => Date.now();

// A recorded event variant minus the fields the kernel assigns. Distributive
// over the RecordedEvent union so each member keeps its discriminated
// `{ type, data }` shape; without the conditional, TS collapses the
// discriminators when Omit is applied to the union as a whole.
type WithoutSeqTs<T> = T extends unknown ? Omit<T, "seq" | "ts"> : never;
type AppendInput = WithoutSeqTs<RecordedEvent> & {
  sessionId: string;
  ts?: number;
};

export interface Kernel {
  readonly version: string;
  readonly append: (
    input: AppendInput,
  ) => Effect.Effect<RecordedEvent, never, never>;
  readonly replay: (
    sessionId: string,
    fromSeq?: number,
  ) => Stream.Stream<RecordedEvent, never, never>;
  /**
   * Gap-free event stream: subscribe first, replay the durable log, then
   * discard duplicate recorded events while preserving every live event.
   */
  readonly events: (
    sessionId: string,
    fromCursor?: number,
  ) => Stream.Stream<SseEvent, never, never>;
  readonly live: (event: LiveEvent) => Effect.Effect<void, never, never>;
  readonly lastSeq: (sessionId: string) => Effect.Effect<number, never, never>;
  readonly projection: () => Effect.Effect<Projection, never, never>;
  readonly event_log: () => Effect.Effect<EventLog, never, never>;
  readonly resolveApproval: (
    approvalId: string,
    decision: ApprovalResolvedData,
  ) => Effect.Effect<boolean, never, never>;
  readonly askForApproval: (
    sessionId: string,
    callId: string,
    name: string,
    input: unknown,
  ) => Effect.Effect<ApprovalResolvedData, never, never>;
}

// deno-lint-ignore no-slow-types
export const Kernel = Context.Service<Kernel, Kernel>()(
  "@niuma/server/Kernel",
);

const newApprovalId = (): string => {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return "ap_" +
    Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

export interface KernelDeps {
  readonly event_log: EventLog;
  readonly projection: Projection;
  readonly approvals?: ApprovalRegistry;
  readonly now?: () => number;
  readonly bus?: {
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
  };
}

export const makeKernel = (
  deps: KernelDeps,
): Effect.Effect<Kernel, never, never> =>
  Effect.gen(function* () {
    const now = deps.now ?? defaultNow;
    const bus = deps.bus;
    const registry: ApprovalRegistry = deps.approvals ??
      (yield* makeApprovalRegistry());
    const seqBySession = yield* Ref.make(new Map<string, number>());
    // Track which sessions we've already hydrated from the JSONL so we only
    // touch event_log.lastSeq once per session per process.
    const hydrated = yield* Ref.make(new Set<string>());

    // Hydrate the in-memory seq counter for `sessionId` from the JSONL tail.
    // Without this, a server restart would re-mint seq=1,2,… and collide with
    // already-recorded events (silent drop in projection's onConflict-doNothing,
    // broken SSE cursors).
    const ensureHydrated = (
      sessionId: string,
    ): Effect.Effect<number, never, never> =>
      Effect.gen(function* () {
        const done = yield* Ref.get(hydrated);
        if (done.has(sessionId)) {
          return (yield* Ref.get(seqBySession)).get(sessionId) ?? 0;
        }
        const last = yield* Effect.promise(() =>
          deps.event_log.lastSeq(sessionId)
        );
        yield* Ref.update(seqBySession, (m) => new Map(m).set(sessionId, last));
        yield* Ref.update(hydrated, (s) => new Set(s).add(sessionId));
        return last;
      });

    const nextSeq = (
      sessionId: string,
    ): Effect.Effect<number, never, never> =>
      Effect.gen(function* () {
        yield* ensureHydrated(sessionId);
        let seq = 0;
        yield* Ref.update(seqBySession, (mm) => {
          const m = new Map(mm);
          const current = m.get(sessionId) ?? 0;
          seq = current + 1;
          m.set(sessionId, seq);
          return m;
        });
        return seq;
      });

    const append: Kernel["append"] = (input) =>
      Effect.gen(function* () {
        const ts = input.ts ?? now();
        const seq = yield* nextSeq(input.sessionId);
        const event = { ...input, seq, ts } as RecordedEvent;
        yield* Effect.promise(() => deps.event_log.append(event));
        yield* Effect.promise(() => deps.projection.apply(event)).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              console.error("projection apply failed:", cause);
            })
          ),
        );
        const sse: SseEvent = { cursor: seq, event };
        if (bus) yield* bus.publish(sse);
        return event;
      });

    const replay: Kernel["replay"] = (sessionId, fromSeq = 0) =>
      Stream.fromAsyncIterable(
        deps.event_log.replay(sessionId, fromSeq),
        (e): never => {
          throw e;
        },
      );

    const events: Kernel["events"] = (sessionId, fromCursor = 0) => {
      const replayAsSse = () =>
        replay(sessionId, fromCursor).pipe(
          Stream.map((event): SseEvent => ({ cursor: event.seq, event })),
        );
      if (!bus) return replayAsSse();

      return Stream.unwrap(
        Effect.gen(function* () {
          // Acquire the PubSub subscription before replay starts. Events
          // appended while replay is reading are therefore buffered.
          const tail = yield* bus.subscribe(sessionId, fromCursor);
          const replayedThrough = yield* Ref.make(
            fromCursor > 0 ? fromCursor - 1 : 0,
          );
          const history = replayAsSse().pipe(
            Stream.mapEffect((sse) =>
              Ref.set(replayedThrough, sse.cursor).pipe(Effect.as(sse))
            ),
          );
          const unseenTail = tail.pipe(
            Stream.filterEffect((sse) =>
              Ref.get(replayedThrough).pipe(
                Effect.map((last) =>
                  !("seq" in sse.event) || sse.cursor > last
                ),
              )
            ),
          );
          return Stream.concat(history, unseenTail);
        }),
      );
    };

    const live: Kernel["live"] = (event) => bus ? bus.live(event) : Effect.void;

    const lastSeq: Kernel["lastSeq"] = (sessionId) =>
      Effect.gen(function* () {
        yield* ensureHydrated(sessionId);
        const m = yield* Ref.get(seqBySession);
        return m.get(sessionId) ?? 0;
      });

    const projection: Kernel["projection"] = () =>
      Effect.succeed(deps.projection);
    const event_log: Kernel["event_log"] = () => Effect.succeed(deps.event_log);

    const resolveApproval: Kernel["resolveApproval"] = (approvalId, decision) =>
      registry.resolve(approvalId, decision);

    const askForApproval: Kernel["askForApproval"] = (
      sessionId,
      callId,
      name,
      input,
    ) =>
      Effect.gen(function* () {
        const approvalId = newApprovalId();
        const request: ApprovalRequestedData = {
          approvalId,
          callId,
          name,
          input,
        };
        const deferred = yield* registry.register(request);
        const awaitResolution = Effect.gen(function* () {
          yield* append({
            type: "approval.requested",
            sessionId,
            data: request,
          });
          return yield* Effect.uninterruptibleMask((restore) =>
            Effect.flatMap(
              restore(Deferred.await(deferred)),
              (resolved) =>
                append({
                  type: "approval.resolved",
                  sessionId,
                  data: resolved,
                }).pipe(Effect.as(resolved)),
            )
          );
        });
        return yield* awaitResolution.pipe(
          Effect.onInterrupt(() =>
            registry.remove(approvalId).pipe(
              Effect.flatMap((removed) =>
                removed
                  ? append({
                    type: "approval.resolved",
                    sessionId,
                    data: {
                      approvalId,
                      decision: "reject",
                      feedback: "aborted",
                    },
                  }).pipe(Effect.asVoid)
                  : Effect.void
              ),
            )
          ),
          Effect.ensuring(registry.remove(approvalId).pipe(Effect.asVoid)),
        );
      });

    return {
      version: SCHEMA_VERSION,
      append,
      replay,
      events,
      live,
      lastSeq,
      projection,
      event_log,
      resolveApproval,
      askForApproval,
    } satisfies Kernel;
  });

export { SCHEMA_VERSION };
