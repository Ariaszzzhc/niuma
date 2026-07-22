import {
  ApprovalReplyReq,
  CreateSessionReq,
  PromptReq,
  type SessionInfo,
  decode,
} from "@niuma/schema";
import { Effect, Exit, ManagedRuntime, Stream } from "effect";
import { Kernel } from "../kernel.ts";
import { SessionManager } from "../session.ts";
import { httpError } from "../error.ts";

// The set of services the handlers need from the runtime.
type R = Kernel | SessionManager;
type Rt = ManagedRuntime.ManagedRuntime<R, unknown>;

export interface Handlers {
  readonly createSession: (raw: unknown) => Promise<{
    sessionId: string;
    workspace: string;
    model: string;
  }>;
  readonly listSessions: () => Promise<ReadonlyArray<SessionInfo>>;
  readonly getSession: (
    id: string,
  ) => Promise<{ info: SessionInfo; history: ReadonlyArray<unknown> }>;
  readonly prompt: (id: string, raw: unknown) => Promise<{ accepted: true }>;
  readonly interrupt: (id: string) => Promise<{ ok: true }>;
  readonly approval: (
    sessionId: string,
    approvalId: string,
    raw: unknown,
  ) => Promise<{ ok: true }>;
  readonly history: (
    id: string,
  ) => Promise<{ events: ReadonlyArray<unknown> }>;
};

const runEffect = async <A>(
  runtime: Rt,
  eff: Effect.Effect<A, unknown, R>,
  code: string,
): Promise<A> => {
  const exit = await runtime.runPromiseExit(eff);
  if (Exit.isFailure(exit)) {
    throw httpError(code, String(exit.cause));
  }
  return exit.value;
};

// Collect a session's recorded events into an array via Stream.runForEach
// (Effect streams are NOT async-iterable in v4, and Effect.gen is a sync
// generator — `for await` inside it is illegal).
const collectReplay = (
  runtime: Rt,
  sessionId: string,
): Promise<unknown[]> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const k = yield* Kernel;
      const out: unknown[] = [];
      yield* k.replay(sessionId, 0).pipe(
        Stream.runForEach((e) => {
          out.push(e);
          return Effect.void;
        }),
      );
      return out;
    }),
  );

export const makeHandlers = (
  runtime: Rt,
): Handlers => ({
  createSession: async (raw) => {
    const req = decode(CreateSessionReq)(raw);
    return runEffect(
      runtime,
      Effect.gen(function* () {
        const sm = yield* SessionManager;
        const info = yield* sm.create({
          workspace: req.workspace ?? ".",
          model: req.model ?? "default",
        });
        return {
          sessionId: info.sessionId,
          workspace: info.workspace,
          model: info.model,
        };
      }),
      "session_create_failed",
    );
  },

  listSessions: () =>
    runEffect(
      runtime,
      Effect.gen(function* () {
        const sm = yield* SessionManager;
        return yield* sm.list();
      }),
      "session_list_failed",
    ),

  getSession: async (id) => {
    const info = await runEffect(
      runtime,
      Effect.gen(function* () {
        const sm = yield* SessionManager;
        return yield* sm.get(id);
      }),
      "session_lookup_failed",
    );
    if (!info) {
      throw httpError("session_not_found", `session ${id} not found`);
    }
    const history = await collectReplay(runtime, id);
    return { info, history };
  },

  prompt: async (id, raw) => {
    const req = decode(PromptReq)(raw);
    return runEffect(
      runtime,
      Effect.gen(function* () {
        const sm = yield* SessionManager;
        yield* sm.prompt(id, [{ type: "text", text: req.text }]);
        return { accepted: true } as const;
      }),
      "prompt_failed",
    );
  },

  interrupt: (id) =>
    runEffect(
      runtime,
      Effect.gen(function* () {
        const sm = yield* SessionManager;
        yield* sm.interrupt(id);
        return { ok: true } as const;
      }),
      "interrupt_failed",
    ),

  approval: async (sessionId, approvalId, raw) => {
    const req = decode(ApprovalReplyReq)(raw);
    return runEffect(
      runtime,
      Effect.gen(function* () {
        const k = yield* Kernel;
        const ok = yield* k.resolveApproval(approvalId, {
          approvalId,
          decision: req.decision,
          ...(req.feedback !== undefined ? { feedback: req.feedback } : {}),
        });
        if (!ok) {
          throw httpError(
            "approval_not_found",
            `approval ${approvalId} not pending`,
          );
        }
        void sessionId;
        return { ok: true } as const;
      }),
      "approval_resolve_failed",
    );
  },

  history: async (id) => {
    const events = await collectReplay(runtime, id);
    return { events };
  },
});
