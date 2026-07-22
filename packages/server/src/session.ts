import {
  Cause,
  Context,
  Effect,
  Fiber,
  Layer,
  Ref,
} from "effect";
import {
  type Part,
  type SessionInfo,
  type SessionStatus,
  type StopReason,
} from "@niuma/schema";
import { runTurn } from "@niuma/agent";
import { Kernel } from "./kernel.ts";
import {
  type AgentInfra,
  kernelApprovalGateway,
  kernelEmitLive,
  kernelEventLog,
} from "./agent_deps.ts";

export interface SessionManager {
  readonly create: (
    input: { workspace: string; model: string },
  ) => Effect.Effect<SessionInfo, never, never>;
  readonly get: (
    id: string,
  ) => Effect.Effect<SessionInfo | undefined, never, never>;
  readonly list: () => Effect.Effect<
    ReadonlyArray<SessionInfo>,
    never,
    never
  >;
  readonly setStatus: (
    id: string,
    status: SessionStatus,
  ) => Effect.Effect<void, never, never>;
  readonly setLastStopReason: (
    id: string,
    reason: StopReason | undefined,
  ) => Effect.Effect<void, never, never>;
  readonly incrementMessageCount: (
    id: string,
    by: number,
  ) => Effect.Effect<void, never, never>;
  readonly prompt: (
    id: string,
    parts: ReadonlyArray<Part>,
  ) => Effect.Effect<void, never, never>;
  readonly interrupt: (id: string) => Effect.Effect<void, never, never>;
  readonly awaitAll: () => Effect.Effect<void, never, never>;
}

export const SessionManager = Context.Service<SessionManager, SessionManager>()(
  "@niuma/server/SessionManager",
);

const now = (): number => Date.now();
const newSessionId = (): string => {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

export interface SessionManagerInfra extends AgentInfra {}

export const makeSessionManager = (
  infra: SessionManagerInfra,
): Effect.Effect<SessionManager, never, Kernel> =>
  Effect.gen(function* () {
    const kernel = yield* Kernel;
    const inflight = yield* Ref.make(
      new Map<string, Fiber.Fiber<unknown, unknown>>(),
    );

    const create: SessionManager["create"] = ({ workspace, model }) =>
      Effect.gen(function* () {
        const sessionId = newSessionId();
        yield* kernel.append({
          type: "session.created",
          sessionId,
          data: { workspace, model },
        });
        const info = yield* kernel.projection().pipe(
          Effect.flatMap((p) => Effect.promise(() => p.getSession(sessionId))),
        );
        if (info) return info;
        return {
          sessionId,
          workspace,
          model,
          createdAt: now(),
          updatedAt: now(),
          status: "idle",
        } satisfies SessionInfo;
      });

    const get: SessionManager["get"] = (id) =>
      Effect.gen(function* () {
        const p = yield* kernel.projection();
        return yield* Effect.promise(() => p.getSession(id));
      });

    const list: SessionManager["list"] = () =>
      Effect.gen(function* () {
        const p = yield* kernel.projection();
        return yield* Effect.promise(() => p.listSessions());
      });

    const setStatus: SessionManager["setStatus"] = (id, status) =>
      Effect.gen(function* () {
        const p = yield* kernel.projection();
        yield* Effect.promise(() =>
          p.db
            .updateTable("sessions")
            .set({ status, updated_at: now() })
            .where("session_id", "=", id)
            .execute()
        );
      });

    const setLastStopReason: SessionManager["setLastStopReason"] = (
      id,
      reason,
    ) =>
      Effect.gen(function* () {
        const p = yield* kernel.projection();
        yield* Effect.promise(() =>
          p.db
            .updateTable("sessions")
            .set({
              last_stop_reason: reason ?? null,
              updated_at: now(),
            })
            .where("session_id", "=", id)
            .execute()
        );
      });

    const incrementMessageCount: SessionManager["incrementMessageCount"] = (
      id,
      _by,
    ) =>
      Effect.gen(function* () {
        const p = yield* kernel.projection();
        // Note: the projection already bumps message_count on user/assistant
        // message events. This helper is for callers that don't go through the
        // event log (e.g. synthetic counts during restore). MVP no-op.
        void p;
        void id;
      });

    // Run a turn to completion in the background. The agent loop appends
    // turn.started / assistant.message / tool.* / turn.completed events as it
    // goes; the kernel fans those out to the JSONL log + projection + SSE bus.
    // Failure isolation: any error is converted to an error.occurred event so
    // the JSONL stays the source of truth and the fiber always exits cleanly.
    const runAgentTurn = (
      sessionId: string,
      parts: ReadonlyArray<Part>,
    ): Effect.Effect<void, never, never> =>
      Effect.gen(function* () {
        const info = yield* kernel.projection().pipe(
          Effect.flatMap((p) => Effect.promise(() => p.getSession(sessionId))),
        );
        const workspace = info?.workspace ?? infra.defaultWorkspace;
        const model = info?.model ?? infra.defaultModel;

        // Record the user message before sampling — runTurn drains its steer
        // queue at each loop top but does not prepend an initial user.message.
        yield* kernel.append({
          type: "user.message",
          sessionId,
          data: { parts: [...parts] },
        });

        const eventLog = kernelEventLog(kernel);
        const approvals = kernelApprovalGateway(kernel);
        const emitLive = kernelEmitLive(kernel);

        yield* runTurn(sessionId, {
          eventLog,
          provider: infra.provider,
          tools: infra.tools,
          approvals,
          model,
          workspace,
          emitLive,
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              // Failure isolation. runTurn records error.occurred for every
              // provider-classified failure (transient retries + terminal), so
              // reaching here means a defect/panic or interruption outside the
              // provider path — never a typed provider error. Label retryable
              // by inspection: a pure defect (a Die with no interrupt) is a
              // genuine programming error → terminal; an interrupt (user or
              // manager cancelled the turn) or any combined/unknown cause
              // defaults to retryable so the UI does not mark the session
              // permanently failed. (Equivalent to `!Cause.isDieType`; this
              // effect build exposes hasDies/hasInterrupts instead.)
              const retryable = !Cause.hasDies(cause) ||
                Cause.hasInterrupts(cause);
              yield* kernel.append({
                type: "error.occurred",
                sessionId,
                data: {
                  message: `turn failed: ${Cause.pretty(cause)}`,
                  retryable,
                },
              });
            }),
          ),
          Effect.ensuring(
            Effect.gen(function* () {
              yield* setStatus(sessionId, "idle");
            }),
          ),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          // Last-resort isolation so a panic in dep wiring does not crash the
          // background fiber silently.
          Effect.sync(() => {
            console.error(`runAgentTurn(${sessionId}) crashed:`, cause);
          }),
        ),
      );

    const prompt: SessionManager["prompt"] = (id, parts) =>
      Effect.gen(function* () {
        // Cancel any in-flight turn for this session before starting a new one.
        const existing = (yield* Ref.get(inflight)).get(id);
        if (existing) {
          yield* Fiber.interrupt(existing);
        }
        const fiber = yield* Effect.forkDetach(runAgentTurn(id, parts));
        yield* Ref.update(inflight, (m) => new Map(m).set(id, fiber));
        // Drop the fiber from the map once it finishes so interrupt/awaitAll
        // don't observe stale entries.
        yield* Effect.forkDetach(
          Fiber.join(fiber).pipe(
            Effect.flatMap(() =>
              Ref.update(inflight, (m) => {
                if (m.get(id) !== fiber) return m;
                const next = new Map(m);
                next.delete(id);
                return next;
              })
            ),
          ),
        );
      });

    const interrupt: SessionManager["interrupt"] = (id) =>
      Effect.gen(function* () {
        const m = yield* Ref.get(inflight);
        const f = m.get(id);
        if (!f) return;
        yield* Fiber.interrupt(f);
        yield* Ref.update(inflight, (mm) => {
          if (mm.get(id) !== f) return mm;
          const next = new Map(mm);
          next.delete(id);
          return next;
        });
      });

    const awaitAll: SessionManager["awaitAll"] = () =>
      Effect.gen(function* () {
        const m = yield* Ref.get(inflight);
        const fibers = Array.from(m.values());
        yield* Fiber.awaitAll(fibers);
      });

    return {
      create,
      get,
      list,
      setStatus,
      setLastStopReason,
      incrementMessageCount,
      prompt,
      interrupt,
      awaitAll,
    } satisfies SessionManager;
  });

export const SessionManagerLive = (
  infra: SessionManagerInfra,
): Layer.Layer<SessionManager, never, Kernel> =>
  Layer.effect(SessionManager, makeSessionManager(infra));
