import {
  ApprovalReplyReq,
  type ClientConfigView,
  type CommandInfo,
  CreateSessionReq,
  decode,
  PromptReq,
  type RecordedEvent,
  type SessionInfo,
  SetEffortReq,
  SetInputDeliveryReq,
  SetModelReq,
} from "@niuma/schema";
import { loadCommands } from "@niuma/config";
import { Effect, Exit, type ManagedRuntime, Result, Stream } from "effect";
import { Kernel } from "../kernel.ts";
import {
  getSessionEnv,
  SessionManager,
  type SetEffortResult,
  type SetModelResult,
  TurnInFlightError,
} from "../session.ts";
import { httpError } from "../error.ts";
import type { ConfigurationRuntime } from "../configuration.ts";

// The set of services the handlers need from the runtime.
type R = Kernel | SessionManager;
type Rt = ManagedRuntime.ManagedRuntime<R, unknown>;

export interface HandlersOptions {
  /** Global niuma config dir; level-1 root for command discovery. When
   * absent (injected test infra) only project-level commands are listed. */
  readonly globalConfigDir?: string;
  /** Server-owned config snapshot + explicit write path. */
  readonly configuration: ConfigurationRuntime;
}

export interface Handlers {
  readonly createSession: (raw: unknown) => Promise<{
    sessionId: string;
    workspace: string;
    model: string;
    /** Resolved context window for the session's model, when known. */
    contextWindow?: number;
    /** MCP servers that came up at boot (empty until/without any). */
    mcpServers: ReadonlyArray<{ id: string; toolCount: number }>;
    /** Custom slash commands visible to this session's workspace. */
    commands: ReadonlyArray<CommandInfo>;
    clientConfig: ClientConfigView;
  }>;
  readonly listSessions: () => Promise<ReadonlyArray<SessionInfo>>;
  readonly listSessionIds: () => Promise<ReadonlyArray<string>>;
  readonly getSession: (
    id: string,
  ) => Promise<{
    info: SessionInfo;
    history: ReadonlyArray<RecordedEvent>;
    contextWindow?: number;
    mcpServers: ReadonlyArray<{ id: string; toolCount: number }>;
    commands: ReadonlyArray<CommandInfo>;
    clientConfig: ClientConfigView;
  }>;
  readonly prompt: (
    id: string,
    raw: unknown,
  ) => Promise<{ disposition: "started" | "steered" | "queued" }>;
  readonly interrupt: (
    id: string,
  ) => Promise<{
    ok: true;
    returnedInputs: ReadonlyArray<{ sourceText: string }>;
  }>;
  readonly setInputDelivery: (
    raw: unknown,
  ) => Promise<{ ok: true; config: ClientConfigView }>;
  readonly setModel: (id: string, raw: unknown) => Promise<SetModelResult>;
  readonly setEffort: (id: string, raw: unknown) => Promise<SetEffortResult>;
  readonly compact: (id: string) => Promise<{ accepted: true }>;
  readonly approval: (
    sessionId: string,
    approvalId: string,
    raw: unknown,
  ) => Promise<{ ok: true }>;
  readonly history: (
    id: string,
  ) => Promise<{ events: ReadonlyArray<unknown> }>;
}

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
): Promise<RecordedEvent[]> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const k = yield* Kernel;
      const out: RecordedEvent[] = [];
      yield* k.replay(sessionId, 0).pipe(
        Stream.runForEach((e) => {
          out.push(e);
          return Effect.void;
        }),
      );
      return out;
    }),
  );

const requireSession = async (
  runtime: Rt,
  id: string,
): Promise<SessionInfo> => {
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
  return info;
};

// List the custom slash commands a workspace sees (user + project levels).
// Best-effort: a broken commands dir yields an empty list, never a failed
// session create.
const listCommands = async (
  opts: HandlersOptions,
  workspace: string,
): Promise<ReadonlyArray<CommandInfo>> => {
  try {
    const table = await loadCommands({
      ...(opts.globalConfigDir !== undefined
        ? { globalConfigDir: opts.globalConfigDir }
        : {}),
      workspace,
    });
    return Array.from(table.values(), (c) => ({
      name: c.name,
      ...(c.description !== undefined ? { description: c.description } : {}),
      ...(c.argumentHint !== undefined ? { argumentHint: c.argumentHint } : {}),
    })).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
};

export const makeHandlers = (
  runtime: Rt,
  opts: HandlersOptions,
): Handlers => ({
  createSession: (raw) => {
    const req = decode(CreateSessionReq)(raw);
    return runEffect(
      runtime,
      Effect.gen(function* () {
        const sm = yield* SessionManager;
        const info = yield* sm.create({
          ...(req.model !== undefined ? { model: req.model } : {}),
        });
        const env = getSessionEnv(sm);
        return {
          sessionId: info.sessionId,
          workspace: info.workspace,
          model: info.model,
          ...(env.contextWindow !== undefined
            ? { contextWindow: env.contextWindow }
            : {}),
          mcpServers: env.mcpServers,
          commands: yield* Effect.promise(() =>
            listCommands(opts, info.workspace)
          ),
          clientConfig: opts.configuration.clientConfig(),
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

  listSessionIds: () =>
    runEffect(
      runtime,
      Effect.gen(function* () {
        const sm = yield* SessionManager;
        return yield* sm.listIds();
      }),
      "session_id_list_failed",
    ),

  getSession: async (id) => {
    const info = await runEffect(
      runtime,
      Effect.gen(function* () {
        const sm = yield* SessionManager;
        return yield* sm.resume(id);
      }),
      "session_lookup_failed",
    );
    if (!info) {
      throw httpError("session_not_found", `session ${id} not found`);
    }
    const history = await collectReplay(runtime, id);
    const created = history.find((event) => event.type === "session.created");
    if (created === undefined) {
      throw httpError(
        "session_corrupt",
        `session ${id} has no session.created event`,
      );
    }
    return {
      info,
      history,
      ...(info.contextWindow !== undefined
        ? { contextWindow: info.contextWindow }
        : {}),
      mcpServers: created.data.mcpServers,
      commands: await listCommands(opts, info.workspace),
      clientConfig: opts.configuration.clientConfig(),
    };
  },

  prompt: async (id, raw) => {
    const req = decode(PromptReq)(raw);
    await requireSession(runtime, id);
    return await runEffect(
      runtime,
      Effect.gen(function* () {
        const sm = yield* SessionManager;
        return yield* sm.prompt(id, {
          parts: [{ type: "text", text: req.text }],
          sourceText: req.text,
        });
      }),
      "prompt_failed",
    );
  },

  interrupt: async (id) => {
    await requireSession(runtime, id);
    return await runEffect(
      runtime,
      Effect.gen(function* () {
        const sm = yield* SessionManager;
        const returnedInputs = yield* sm.interrupt(id);
        return { ok: true as const, returnedInputs };
      }),
      "interrupt_failed",
    );
  },

  setInputDelivery: (raw) => {
    const req = decode(SetInputDeliveryReq)(raw);
    return runEffect(
      runtime,
      Effect.tryPromise(() =>
        opts.configuration.setInputDelivery(req.inputDelivery)
      ).pipe(
        Effect.map((config) => ({ ok: true as const, config })),
      ),
      "config_update_failed",
    );
  },

  // Session-existence is checked up front (same convention as getSession) so
  // a typo'd id surfaces as session_not_found, not a generic failure code.
  setModel: async (id, raw) => {
    const req = decode(SetModelReq)(raw);
    await requireSession(runtime, id);
    return await runEffect(
      runtime,
      Effect.gen(function* () {
        const sm = yield* SessionManager;
        return yield* sm.setModel(id, req.model);
      }),
      "set_model_failed",
    );
  },

  setEffort: async (id, raw) => {
    const req = decode(SetEffortReq)(raw);
    await requireSession(runtime, id);
    return await runEffect(
      runtime,
      Effect.gen(function* () {
        const sm = yield* SessionManager;
        return yield* sm.setEffort(id, req.effort);
      }),
      "set_effort_failed",
    );
  },

  // Session-existence is checked up front (same convention as setModel); the
  // manager itself refuses with TurnInFlightError while a turn is running,
  // which surfaces here as a 409 rather than a generic failure code.
  compact: async (id) => {
    await requireSession(runtime, id);
    const result = await runEffect(
      runtime,
      Effect.gen(function* () {
        const sm = yield* SessionManager;
        return yield* Effect.result(sm.compact(id));
      }),
      "compact_failed",
    );
    if (Result.isFailure(result)) {
      if (result.failure instanceof TurnInFlightError) {
        throw httpError(
          "turn_in_flight",
          `session ${id} has a turn in flight; retry when it completes`,
        );
      }
      throw httpError("compact_failed", String(result.failure));
    }
    return result.success;
  },

  approval: (sessionId, approvalId, raw) => {
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
    await requireSession(runtime, id);
    const events = await collectReplay(runtime, id);
    return { events };
  },
});
