import { Cause, Context, Data, Effect, Fiber, Ref, Semaphore } from "effect";
import type {
  BillingMode,
  InputDelivery,
  Part,
  PromptRes,
  SessionInfo,
  UserMessageEvent,
} from "@niuma/schema";
import { compactSession, runTurn } from "@niuma/agent";
import {
  expandCommandTemplate,
  loadCommands,
  resolveModelRef,
} from "@niuma/config";
import type { ProviderAdapter, ThinkingConfig } from "@niuma/provider";
import { Kernel } from "./kernel.ts";
import {
  type AgentInfra,
  kernelApprovalGateway,
  kernelEmitLive,
  kernelSessionJournal,
} from "./agent_deps.ts";
import type { SessionState } from "./session_state.ts";

export interface SessionManager {
  readonly create: (
    input: { model?: string },
  ) => Effect.Effect<SessionInfo, Error, never>;
  readonly get: (
    id: string,
  ) => Effect.Effect<SessionInfo | undefined, never, never>;
  readonly list: () => Effect.Effect<
    ReadonlyArray<SessionInfo>,
    never,
    never
  >;
  readonly listIds: () => Effect.Effect<
    ReadonlyArray<string>,
    never,
    never
  >;
  readonly resume: (
    id: string,
  ) => Effect.Effect<SessionInfo | undefined, never, never>;
  /** Switch the session's model for subsequent turns. Accepts a full
   * "provider/model-id" ref (cross-provider: rebuilds the adapter) or a
   * bare model-id (same provider). Fails when the session does not exist
   * or the ref cannot be resolved against the boot config. */
  readonly setModel: (
    id: string,
    model: string,
  ) => Effect.Effect<SetModelResult, Error, never>;
  /** Override the thinking effort for subsequent turns (verbatim
   * provider档位 string, merged over the session's thinking config). */
  readonly setEffort: (
    id: string,
    effort: string,
  ) => Effect.Effect<SetEffortResult, Error, never>;
  readonly prompt: (
    id: string,
    input: SubmittedInput,
  ) => Effect.Effect<PromptResult, never, never>;
  /** Compact the session's history in the background (the /compact command).
   * Fails with TurnInFlightError while a turn/compaction is running;
   * otherwise forks compactSession (@niuma/agent) and returns immediately —
   * the outcome lands as a compaction.performed event (or nothing, when the
   * history is too short to be worth folding). */
  readonly compact: (
    id: string,
  ) => Effect.Effect<{ accepted: true }, TurnInFlightError, never>;
  readonly interrupt: (
    id: string,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly sourceText: string }>,
    never,
    never
  >;
  readonly awaitAll: () => Effect.Effect<void, never, never>;
  readonly isActive: (
    id: string,
  ) => Effect.Effect<boolean, never, never>;
}

// deno-lint-ignore no-slow-types
export const SessionManager = Context.Service<SessionManager, SessionManager>()(
  "@niuma/server/SessionManager",
);

const now = (): number => Date.now();
const newSessionId = (): string => {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

export interface SetModelResult {
  readonly ok: true;
  readonly model: string;
  readonly contextWindow?: number;
}

export interface SetEffortResult {
  readonly ok: true;
  readonly effort: string;
}

export interface SubmittedInput {
  readonly parts: ReadonlyArray<Part>;
  readonly sourceText: string;
}

export interface PromptResult {
  readonly disposition: PromptRes["disposition"];
}

/** SessionManager.compact fails with this when the session still has a turn
 * (or an earlier compaction) in flight — the replay + summary append must not
 * interleave with live turn events. The HTTP handler maps it to 409
 * turn_in_flight. */
export class TurnInFlightError extends Data.TaggedError("TurnInFlightError")<
  { readonly sessionId: string }
> {
}

// ---------------------------------------------------------------------------
// Per-session model runtime cache
// ---------------------------------------------------------------------------
// Model and effort are Session State derived from events. This cache holds
// only rebuilt provider adapters and resolved request limits; a restart can
// recreate it from the Session Journal before the next Model Call.

interface SessionRuntime {
  readonly modelRef: string;
  readonly modelId: string;
  readonly providerId?: string;
  readonly provider: ProviderAdapter;
  readonly billingMode: BillingMode;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly thinking?: ThinkingConfig;
  readonly effort?: string;
}

// Mirror of bootstrap.ts's thinkingFromModel: project a resolved model
// config's thinking fields into a provider-level ThinkingConfig, undefined
// when the model sets neither (duplicated here to keep bootstrap → session
// the only import direction between those two modules).
const thinkingFromModelConfig = (
  model: Readonly<{ thinkingEffort?: string; thinkingKeep?: "all" | "none" }>,
): ThinkingConfig | undefined => {
  if (
    model.thinkingEffort === undefined && model.thinkingKeep === undefined
  ) {
    return undefined;
  }
  return {
    ...(model.thinkingEffort !== undefined
      ? { effort: model.thinkingEffort }
      : {}),
    ...(model.thinkingKeep !== undefined ? { keep: model.thinkingKeep } : {}),
  };
};

// ---------------------------------------------------------------------------
// Custom slash command expansion
// ---------------------------------------------------------------------------
// A prompt whose text is `/name args...` is expanded server-side against the
// user/project `commands/*.md` templates (@niuma/config) so every client —
// TUI, one-shot, serve — shares one code path and the Session Journal records
// expanded text (replay-safe). The typed input is preserved as `sourceText`
// on the user.message event for display surfaces. An unmatched `/whatever`
// passes through as a plain message (no error), and any discovery failure
// degrades to the same pass-through — a broken commands dir must never sink
// a turn.

const SLASH_COMMAND_REGEX = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/;

interface ExpandedPrompt {
  readonly parts: ReadonlyArray<Part>;
  /** Present only when a command was expanded. */
  readonly sourceText?: string;
}

const expandSlashCommand = (
  infra: SessionManagerInfra,
  workspace: string,
  parts: ReadonlyArray<Part>,
): Effect.Effect<ExpandedPrompt, never, never> => {
  const first = parts[0];
  if (parts.length !== 1 || first?.type !== "text") {
    return Effect.succeed({ parts });
  }
  const m = first.text.match(SLASH_COMMAND_REGEX);
  if (!m) return Effect.succeed({ parts });
  return Effect.promise(() =>
    loadCommands({
      ...(infra.globalConfigDir !== undefined
        ? { globalConfigDir: infra.globalConfigDir }
        : {}),
      workspace,
      // Discovery failure degrades to "no commands" — a broken commands dir
      // must never sink a turn.
    }).catch(() => new Map() as Awaited<ReturnType<typeof loadCommands>>)
  ).pipe(
    Effect.map((commands) => {
      const def = commands.get(m[1]);
      if (!def) return { parts } satisfies ExpandedPrompt;
      const text = expandCommandTemplate(def.template, m[2] ?? "");
      return {
        parts: [{ type: "text", text } as Part],
        sourceText: first.text,
      } satisfies ExpandedPrompt;
    }),
  );
};

// ---------------------------------------------------------------------------
// Session-manager environment metadata
// ---------------------------------------------------------------------------
// Ambient facts the TUI status line wants at boot (before the first turn):
// the resolved context-window size and the MCP servers that came up. Captured
// once on the service so any consumer (HTTP handlers, future in-process
// callers) reads the same snapshot.

export interface McpServerStatus {
  readonly id: string;
  /** Tools the server contributed to the shared registry. */
  readonly toolCount: number;
}

export interface SessionManagerEnv {
  readonly contextWindow?: number;
  readonly mcpServers: ReadonlyArray<McpServerStatus>;
}

const sessionEnv = new Map<SessionManager, SessionManagerEnv>();

/** Attach boot metadata to a SessionManager instance (bootstrap-only). */
export const bindSessionEnv = (
  sm: SessionManager,
  env: SessionManagerEnv,
): SessionManager => {
  sessionEnv.set(sm, env);
  return sm;
};

/** Read the boot metadata bound to a SessionManager (empty when unbound —
 * e.g. a hand-rolled test double that never went through bootstrap). */
export const getSessionEnv = (
  sm: SessionManager,
): SessionManagerEnv => sessionEnv.get(sm) ?? { mcpServers: [] };

export interface SessionManagerInfra extends AgentInfra {}

interface PendingInput {
  /** Expanded content recorded and sent to the provider on consumption. */
  readonly parts: ReadonlyArray<Part>;
  /** Exact client text returned when the input is not consumed. */
  readonly sourceText: string;
  /** Included on user.message only when slash-command expansion changed the
   * provider-facing content. */
  readonly eventSourceText?: string;
}

type TurnPhase = "accepting" | "interrupting" | "closing";
type TurnTermination = "completed" | "interrupted" | "failed";

interface ActiveTurn {
  readonly kind: "turn";
  readonly token: object;
  readonly turnId: string;
  readonly controller: AbortController;
  phase: TurnPhase;
  readonly pending: PendingInput[];
  fiber?: Fiber.Fiber<unknown, unknown>;
}

interface ActiveCompaction {
  readonly kind: "compaction";
  readonly token: object;
  fiber?: Fiber.Fiber<unknown, unknown>;
}

type ActiveExecution = ActiveTurn | ActiveCompaction;

interface SessionExecution {
  active?: ActiveExecution;
  /** Inputs not yet bound to a Turn. Each entry becomes its own future Turn. */
  readonly fifo: PendingInput[];
}

export const makeSessionManager = (
  infra: SessionManagerInfra,
  env: SessionManagerEnv = { mcpServers: [] },
): Effect.Effect<SessionManager, never, Kernel> =>
  Effect.gen(function* () {
    const kernel = yield* Kernel;
    const runtimes = yield* Ref.make(new Map<string, SessionRuntime>());
    const executions = new Map<string, SessionExecution>();
    const locks = new Map<
      string,
      ReturnType<typeof Semaphore.makeUnsafe>
    >();

    const executionFor = (id: string): SessionExecution => {
      const existing = executions.get(id);
      if (existing) return existing;
      const created: SessionExecution = { fifo: [] };
      executions.set(id, created);
      return created;
    };

    const lockFor = (
      id: string,
    ): ReturnType<typeof Semaphore.makeUnsafe> => {
      const existing = locks.get(id);
      if (existing) return existing;
      const created = Semaphore.makeUnsafe(1);
      locks.set(id, created);
      return created;
    };

    const withSessionLock = <A, E, R>(
      id: string,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> => lockFor(id).withPermit(effect);

    const canonicalModelRef = (
      requested: string,
      current?: string,
    ): string => {
      if (requested.includes("/")) return requested;
      const currentProvider = current?.includes("/")
        ? current.slice(0, current.indexOf("/"))
        : infra.defaultProviderId;
      return currentProvider ? `${currentProvider}/${requested}` : requested;
    };

    const buildRuntime = (
      modelRef: string,
      effort?: string,
    ): Effect.Effect<SessionRuntime, Error, never> =>
      Effect.gen(function* () {
        let modelId = modelRef;
        let providerId = infra.defaultProviderId;
        let provider = infra.provider;
        let contextWindow = infra.defaultContextWindow;
        let maxTokens = infra.defaultMaxTokens;
        let thinking = infra.defaultThinking;

        if (modelRef.includes("/")) {
          const slash = modelRef.indexOf("/");
          providerId = modelRef.slice(0, slash);
          modelId = modelRef.slice(slash + 1);
          if (infra.config) {
            const resolved = yield* Effect.try(() =>
              resolveModelRef(infra.config!, modelRef)
            );
            providerId = resolved.provider.id;
            modelId = resolved.modelId;
            contextWindow = resolved.model.contextWindow;
            maxTokens = resolved.model.maxOutput;
            thinking = thinkingFromModelConfig(resolved.model);
            if (providerId !== infra.defaultProviderId) {
              if (!infra.makeProvider) {
                return yield* Effect.fail(
                  new Error(
                    `model ${modelRef} needs a provider factory`,
                  ),
                );
              }
              provider = yield* Effect.tryPromise(() =>
                infra.makeProvider!(infra.config!, modelRef)
              );
            }
          }
        }

        const billingMode = providerId && infra.billingModeForProvider
          ? yield* Effect.tryPromise(() =>
            infra.billingModeForProvider!(providerId!)
          )
          : infra.defaultBillingMode ?? "unknown";
        return {
          modelRef,
          modelId,
          ...(providerId !== undefined ? { providerId } : {}),
          provider,
          billingMode,
          ...(contextWindow !== undefined ? { contextWindow } : {}),
          ...(maxTokens !== undefined ? { maxTokens } : {}),
          ...(thinking !== undefined ? { thinking } : {}),
          ...(effort !== undefined ? { effort } : {}),
        };
      });

    const runtimeFor = (
      id: string,
      state: SessionState,
    ): Effect.Effect<SessionRuntime, Error, never> =>
      Effect.gen(function* () {
        const cached = (yield* Ref.get(runtimes)).get(id);
        if (
          cached?.modelRef === state.info.model &&
          cached.effort === state.effort
        ) {
          return cached;
        }
        const runtime = yield* buildRuntime(state.info.model, state.effort);
        yield* Ref.update(runtimes, (map) => new Map(map).set(id, runtime));
        return runtime;
      });

    const recoverState = (
      id: string,
      state: SessionState,
    ): Effect.Effect<SessionState, never, never> =>
      Effect.gen(function* () {
        if (executions.get(id)?.active) return state;
        for (const approval of state.pendingApprovals.values()) {
          yield* kernel.append({
            type: "approval.resolved",
            sessionId: id,
            data: {
              approvalId: approval.approvalId,
              decision: "reject",
              feedback: "server restarted",
            },
          });
        }
        if (state.activeTurnId) {
          yield* kernel.append({
            type: "turn.aborted",
            sessionId: id,
            data: {
              turnId: state.activeTurnId,
              reason: "server restarted",
            },
          });
        }
        return (yield* kernel.state(id)) ?? state;
      });

    const create: SessionManager["create"] = ({ model }) =>
      Effect.gen(function* () {
        const sessionId = newSessionId();
        const requested = model ?? infra.defaultModelRef ??
          (infra.defaultModel || "default");
        const sessionModel = canonicalModelRef(requested);
        const runtime = yield* buildRuntime(sessionModel);
        yield* kernel.append({
          type: "session.created",
          sessionId,
          data: {
            workspace: infra.defaultWorkspace,
            model: sessionModel,
            ...(runtime.contextWindow !== undefined
              ? { contextWindow: runtime.contextWindow }
              : {}),
            mcpServers: [...env.mcpServers],
          },
        });
        yield* Ref.update(runtimes, (map) =>
          new Map(map).set(sessionId, runtime));
        const state = yield* kernel.state(sessionId);
        return state!.info;
      });

    const get: SessionManager["get"] = (id) =>
      Effect.map(kernel.state(id), (state) =>
        state?.info);

    const list: SessionManager["list"] = () =>
      Effect.map(kernel.listRecent(), (states) =>
        states.map((state) =>
          state.info
        ));

    const listIds: SessionManager["listIds"] = () => kernel.listIds();

    const resume: SessionManager["resume"] = (id) =>
      withSessionLock(
        id,
        Effect.gen(function* () {
          // Touch first so Resume and Retention have one deterministic race:
          // whichever acquires the SessionStore lock first wins. A successful
          // touch makes the Journal fresh before any replay/recovery work.
          if (!(yield* kernel.touch(id))) return undefined;
          const current = yield* kernel.state(id);
          if (!current) return undefined;
          const recovered = yield* recoverState(id, current);
          return recovered.info;
        }),
      );

    const setModel: SessionManager["setModel"] = (id, requested) =>
      withSessionLock(
        id,
        Effect.gen(function* () {
          const state = yield* kernel.state(id);
          if (!state) {
            return yield* Effect.fail(new Error(`session ${id} not found`));
          }
          const modelRef = canonicalModelRef(requested, state.info.model);
          const runtime = yield* buildRuntime(modelRef, state.effort);
          yield* kernel.append({
            type: "session.model.changed",
            sessionId: id,
            data: {
              model: modelRef,
              ...(runtime.contextWindow !== undefined
                ? { contextWindow: runtime.contextWindow }
                : {}),
            },
          });
          yield* Ref.update(runtimes, (map) => new Map(map).set(id, runtime));
          return {
            ok: true as const,
            model: modelRef,
            ...(runtime.contextWindow !== undefined
              ? { contextWindow: runtime.contextWindow }
              : {}),
          };
        }),
      );

    const setEffort: SessionManager["setEffort"] = (id, effort) =>
      withSessionLock(
        id,
        Effect.gen(function* () {
          const state = yield* kernel.state(id);
          if (!state) {
            return yield* Effect.fail(new Error(`session ${id} not found`));
          }
          const runtime = yield* buildRuntime(state.info.model, effort);
          yield* kernel.append({
            type: "session.effort.changed",
            sessionId: id,
            data: { effort },
          });
          yield* Ref.update(runtimes, (map) => new Map(map).set(id, runtime));
          return { ok: true as const, effort };
        }),
      );

    // Input Coordinator ----------------------------------------------------
    //
    // `boundPending` and FIFO are intentionally different state. The former
    // belongs to the active Turn and is recoverable on interrupt/failure; the
    // latter has not been bound to any Turn and continues automatically.
    // Every transition below runs under the same per-session semaphore.

    const startTurnLocked = (
      sessionId: string,
      state: SessionExecution,
      input: PendingInput,
    ): Effect.Effect<void, never, never> =>
      Effect.gen(function* () {
        const token = {};
        const turnId = crypto.randomUUID();
        const controller = new AbortController();
        const active: ActiveTurn = {
          kind: "turn",
          token,
          turnId,
          controller,
          phase: "accepting",
          pending: [input],
        };
        state.active = active;
        const fiber = yield* Effect.forkDetach(
          runAgentTurn(sessionId, token, turnId, controller),
        );
        active.fiber = fiber;
      });

    const turnInputFor = (
      sessionId: string,
      token: object,
    ) => ({
      claim: (): Effect.Effect<ReadonlyArray<UserMessageEvent>> =>
        withSessionLock(
          sessionId,
          Effect.uninterruptible(
            Effect.gen(function* () {
              const active = executionFor(sessionId).active;
              if (
                active?.kind !== "turn" ||
                active.token !== token ||
                active.phase !== "accepting"
              ) {
                return [];
              }

              const recorded: UserMessageEvent[] = [];
              // Append and remove one-by-one. If a later append defects, every
              // earlier item is already consumed and every later item remains
              // recoverable; no input occupies a "removed but not recorded"
              // state.
              while (active.pending.length > 0) {
                const input = active.pending[0];
                const event = yield* kernel.append({
                  type: "user.message",
                  sessionId,
                  data: {
                    parts: [...input.parts],
                    ...(input.eventSourceText !== undefined
                      ? { sourceText: input.eventSourceText }
                      : {}),
                  },
                });
                active.pending.shift();
                recorded.push(event as UserMessageEvent);
              }
              return recorded;
            }),
          ),
        ),

      tryClose: () =>
        withSessionLock(
          sessionId,
          Effect.sync(() => {
            const active = executionFor(sessionId).active;
            if (active?.kind !== "turn" || active.token !== token) {
              return "interrupted" as const;
            }
            if (active.phase === "interrupting") {
              return "interrupted" as const;
            }
            if (active.phase === "closing") {
              return "close" as const;
            }
            if (active.pending.length > 0) {
              return "continue" as const;
            }
            active.phase = "closing";
            return "close" as const;
          }),
        ),
    });

    const finalizeTurn = (
      sessionId: string,
      token: object,
      termination: TurnTermination,
    ): Effect.Effect<
      ReadonlyArray<{ readonly sourceText: string }>,
      never,
      never
    > =>
      withSessionLock(
        sessionId,
        Effect.gen(function* () {
          const state = executionFor(sessionId);
          const active = state.active;
          if (active?.kind !== "turn" || active.token !== token) {
            return [];
          }

          const recovered = termination === "failed"
            ? active.pending.splice(0).map(({ sourceText }) => ({ sourceText }))
            : [];
          state.active = undefined;

          const next = state.fifo.shift();
          if (next) {
            yield* startTurnLocked(sessionId, state, next);
          }
          return recovered;
        }),
      );

    // Run a turn to completion in the background. Inputs are not recorded at
    // admission: runTurn claims them immediately before each provider request.
    // Terminal failure returns whatever remains bound-but-unconsumed through a
    // live-only input.recovered event; explicit interrupt returns it directly
    // to the requesting client and therefore emits no duplicate live event.
    const runAgentTurn = (
      sessionId: string,
      token: object,
      turnId: string,
      controller: AbortController,
    ): Effect.Effect<void, never, never> => {
      let termination: TurnTermination = "failed";

      return Effect.gen(function* () {
        const state = yield* kernel.state(sessionId);
        if (!state) {
          return yield* Effect.die(
            new Error(`session ${sessionId} not found`),
          );
        }
        const runtime = yield* runtimeFor(sessionId, state);
        const baseThinking = runtime.thinking;
        const thinking = runtime.effort !== undefined
          ? { ...baseThinking, effort: runtime.effort }
          : baseThinking;

        const result = yield* runTurn(sessionId, {
          journal: kernelSessionJournal(kernel),
          provider: runtime.provider,
          tools: infra.tools,
          approvals: kernelApprovalGateway(kernel),
          model: runtime.modelId,
          ...(runtime.providerId !== undefined
            ? { providerId: runtime.providerId }
            : {}),
          billingMode: runtime.billingMode,
          actor: "main",
          turnId,
          workspace: state.info.workspace,
          emitLive: kernelEmitLive(kernel),
          signal: controller.signal,
          input: turnInputFor(sessionId, token),
          ...(runtime.contextWindow !== undefined
            ? { contextWindow: runtime.contextWindow }
            : {}),
          ...(runtime.maxTokens !== undefined
            ? { maxTokens: runtime.maxTokens }
            : {}),
          ...(thinking !== undefined ? { thinking } : {}),
        });
        termination = result.stopReason === "abort"
          ? "interrupted"
          : result.stopReason === "error"
          ? "failed"
          : "completed";
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            termination = controller.signal.aborted ? "interrupted" : "failed";
            if (termination === "failed") {
              yield* kernel.append({
                type: "error.occurred",
                sessionId,
                data: {
                  message: `turn failed: ${Cause.pretty(cause)}`,
                  retryable: false,
                },
              });
              // A defect bypasses runTurn's normal terminal event; close the
              // visible Turn explicitly so clients do not remain "running".
              yield* kernel.append({
                type: "turn.aborted",
                sessionId,
                data: { turnId, reason: "turn failed" },
              });
            } else {
              yield* kernel.append({
                type: "turn.aborted",
                sessionId,
                data: { turnId, reason: "signal" },
              });
            }
          })
        ),
        Effect.ensuring(
          Effect.gen(function* () {
            const recovered = yield* finalizeTurn(
              sessionId,
              token,
              termination,
            );
            if (recovered.length > 0) {
              yield* kernel.live({
                type: "input.recovered",
                ts: now(),
                sessionId,
                data: { reason: "turn_failed", inputs: [...recovered] },
              });
            }
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            console.error(`runAgentTurn(${sessionId}) crashed:`, cause);
          })
        ),
      );
    };

    // Background compaction (the /compact command): compactSession replays
    // the Journal, summarizes, and appends a compaction.performed event.
    // Failure isolation mirrors runAgentTurn — a failure becomes an
    // error.occurred event so the Journal stays the source of truth, with a
    // last-resort console.error for dep-wiring panics. (compactSession
    // itself already falls back to the template summary when the LLM call
    // fails, so reaching catchCause means replay/append broke.)
    const finalizeCompaction = (
      sessionId: string,
      token: object,
    ): Effect.Effect<void, never, never> =>
      withSessionLock(
        sessionId,
        Effect.gen(function* () {
          const state = executionFor(sessionId);
          const active = state.active;
          if (active?.kind !== "compaction" || active.token !== token) return;
          state.active = undefined;
          const next = state.fifo.shift();
          if (next) yield* startTurnLocked(sessionId, state, next);
        }),
      );

    const runCompaction = (
      sessionId: string,
      token: object,
    ): Effect.Effect<void, never, never> =>
      Effect.gen(function* () {
        const state = yield* kernel.state(sessionId);
        if (!state) {
          return yield* Effect.die(
            new Error(`session ${sessionId} not found`),
          );
        }
        const runtime = yield* runtimeFor(sessionId, state);

        yield* compactSession(sessionId, {
          journal: kernelSessionJournal(kernel),
          provider: runtime.provider,
          ...(runtime.providerId !== undefined
            ? { providerId: runtime.providerId }
            : {}),
          model: runtime.modelId,
          billingMode: runtime.billingMode,
          actor: "main",
        }).pipe(
          Effect.catchCause((cause) =>
            kernel.append({
              type: "error.occurred",
              sessionId,
              data: {
                message: `compaction failed: ${Cause.pretty(cause)}`,
                retryable: true,
              },
            })
          ),
        );
      }).pipe(
        Effect.ensuring(finalizeCompaction(sessionId, token)),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            console.error(`runCompaction(${sessionId}) crashed:`, cause);
          })
        ),
      );

    const startCompactionLocked = (
      sessionId: string,
      state: SessionExecution,
    ): Effect.Effect<void, never, never> =>
      Effect.gen(function* () {
        const token = {};
        const active: ActiveCompaction = { kind: "compaction", token };
        state.active = active;
        const fiber = yield* Effect.forkDetach(
          runCompaction(sessionId, token),
        );
        active.fiber = fiber;
      });

    const prompt: SessionManager["prompt"] = (id, input) =>
      Effect.gen(function* () {
        const current = yield* kernel.state(id);
        const recovered = current
          ? yield* recoverState(id, current)
          : undefined;
        const workspace = recovered?.info.workspace ?? infra.defaultWorkspace;
        const expanded = yield* expandSlashCommand(
          infra,
          workspace,
          input.parts,
        );
        const pending: PendingInput = {
          parts: expanded.parts,
          sourceText: input.sourceText,
          ...(expanded.sourceText !== undefined
            ? { eventSourceText: expanded.sourceText }
            : {}),
        };

        return yield* withSessionLock(
          id,
          Effect.gen(function* () {
            const state = executionFor(id);
            const active = state.active;
            if (!active) {
              yield* startTurnLocked(id, state, pending);
              return { disposition: "started" as const };
            }

            const mode: InputDelivery = infra.inputDelivery?.() ?? "steer";
            if (
              active.kind === "turn" &&
              active.phase === "accepting" &&
              mode === "steer"
            ) {
              active.pending.push(pending);
              return { disposition: "steered" as const };
            }

            // Queue mode, compaction, or a Turn whose admission has already
            // closed all land in the future-Turn FIFO.
            state.fifo.push(pending);
            return { disposition: "queued" as const };
          }),
        );
      });

    const compact: SessionManager["compact"] = (id) =>
      withSessionLock(
        id,
        Effect.gen(function* () {
          const state = executionFor(id);
          if (state.active) {
            return yield* Effect.fail(
              new TurnInFlightError({ sessionId: id }),
            );
          }
          yield* startCompactionLocked(id, state);
          return { accepted: true as const };
        }),
      );

    const interrupt: SessionManager["interrupt"] = (id) =>
      Effect.gen(function* () {
        // Pin this request to the Turn visible when the request enters the
        // coordinator. If that Turn finalizes while we are waiting for the
        // semaphore and promotes a FIFO successor, the token mismatch below
        // prevents a late interrupt from accidentally aborting the successor.
        const observedToken = yield* Effect.sync(() => {
          const active = executionFor(id).active;
          return active?.kind === "turn" ? active.token : undefined;
        });
        if (observedToken === undefined) return [];

        const target = yield* withSessionLock(
          id,
          Effect.sync(() => {
            const active = executionFor(id).active;
            if (
              active?.kind !== "turn" ||
              active.token !== observedToken ||
              active.phase === "closing"
            ) {
              return {
                returnedInputs: [] as Array<{ sourceText: string }>,
                fiber: undefined,
              };
            }
            if (active.phase === "interrupting") {
              return {
                returnedInputs: [] as Array<{ sourceText: string }>,
                fiber: active.fiber,
              };
            }
            active.phase = "interrupting";
            const returnedInputs = active.pending.splice(0).map(
              ({ sourceText }) => ({ sourceText }),
            );
            active.controller.abort("user interrupt");
            return { returnedInputs, fiber: active.fiber };
          }),
        );
        // Normal interrupt is cooperative: provider/tool/approval paths all
        // observe the AbortSignal and let runTurn append turn.aborted. Waiting
        // here means FIFO promotion has completed before the response returns.
        if (target.fiber) yield* Fiber.await(target.fiber);
        return target.returnedInputs;
      });

    const awaitAll: SessionManager["awaitAll"] = () =>
      Effect.gen(function* () {
        while (true) {
          const fibers = Array.from(executions.values())
            .map((state) => state.active?.fiber)
            .filter(
              (fiber): fiber is Fiber.Fiber<unknown, unknown> =>
                fiber !== undefined,
            );
          if (fibers.length === 0) return;
          yield* Fiber.awaitAll(fibers);
        }
      });

    const isActive: SessionManager["isActive"] = (id) =>
      Effect.sync(() => executions.get(id)?.active !== undefined);

    return {
      create,
      get,
      list,
      listIds,
      resume,
      setModel,
      setEffort,
      prompt,
      compact,
      interrupt,
      awaitAll,
      isActive,
    } satisfies SessionManager;
  });
