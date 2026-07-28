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
import type { SessionEventInput, SessionStore } from "./session_store.ts";
import type { SessionState } from "./session_state.ts";

const defaultNow = (): number => Date.now();

// A recorded event variant minus the fields the kernel assigns. Distributive
// over the RecordedEvent union so each member keeps its discriminated
// `{ type, data }` shape; without the conditional, TS collapses the
// discriminators when Omit is applied to the union as a whole.
type AppendInput = SessionEventInput;

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
  readonly state: (
    sessionId: string,
  ) => Effect.Effect<SessionState | undefined, never, never>;
  readonly listRecent: (
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<SessionState>, never, never>;
  readonly listIds: () => Effect.Effect<ReadonlyArray<string>, never, never>;
  readonly touch: (sessionId: string) => Effect.Effect<boolean, never, never>;
  readonly resolveApproval: (
    approvalId: string,
    decision: ApprovalResolvedData,
  ) => Effect.Effect<boolean, never, never>;
  readonly askForApproval: (
    sessionId: string,
    callId: string,
    name: string,
    input: unknown,
    signal?: AbortSignal,
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
  readonly store: SessionStore;
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
    const append: Kernel["append"] = (input) =>
      Effect.gen(function* () {
        const event = yield* Effect.promise(() =>
          deps.store.append({ ...input, ts: input.ts ?? now() })
        );
        const sse: SseEvent = { cursor: event.seq, event };
        if (bus) yield* bus.publish(sse);
        return event;
      });

    const replay: Kernel["replay"] = (sessionId, fromSeq = 0) =>
      Stream.fromAsyncIterable(
        deps.store.replay(sessionId, fromSeq),
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
      Effect.promise(() => deps.store.lastSeq(sessionId));
    const state: Kernel["state"] = (sessionId) =>
      Effect.promise(() => deps.store.state(sessionId));
    const listRecent: Kernel["listRecent"] = (limit) =>
      Effect.promise(() => deps.store.listRecent(limit));
    const listIds: Kernel["listIds"] = () =>
      Effect.promise(() => deps.store.listIds());
    const touch: Kernel["touch"] = (sessionId) =>
      Effect.promise(() => deps.store.touch(sessionId));

    const resolveApproval: Kernel["resolveApproval"] = (approvalId, decision) =>
      registry.resolve(approvalId, decision);

    const askForApproval: Kernel["askForApproval"] = (
      sessionId,
      callId,
      name,
      input,
      signal,
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
          const waitForDecision = signal
            ? Effect.race(
              Deferred.await(deferred).pipe(
                Effect.map((value) => ({
                  kind: "resolved" as const,
                  value,
                })),
              ),
              Effect.callback<"aborted">((resume) => {
                const onAbort = (): void => {
                  resume(Effect.succeed("aborted"));
                };
                if (signal.aborted) {
                  onAbort();
                  return;
                }
                signal.addEventListener("abort", onAbort, { once: true });
                return Effect.sync(() =>
                  signal.removeEventListener("abort", onAbort)
                );
              }).pipe(
                Effect.map(() => ({ kind: "aborted" as const })),
              ),
            )
            : Deferred.await(deferred).pipe(
              Effect.map((value) => ({
                kind: "resolved" as const,
                value,
              })),
            );
          return yield* Effect.uninterruptibleMask((restore) =>
            Effect.flatMap(
              restore(waitForDecision),
              (outcome) => {
                const resolved: ApprovalResolvedData =
                  outcome.kind === "resolved"
                    ? outcome.value
                    : {
                      approvalId,
                      decision: "reject",
                      feedback: "aborted",
                    };
                return append({
                  type: "approval.resolved",
                  sessionId,
                  data: resolved,
                }).pipe(Effect.as(resolved));
              },
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
      state,
      listRecent,
      listIds,
      touch,
      resolveApproval,
      askForApproval,
    } satisfies Kernel;
  });

export { SCHEMA_VERSION };
