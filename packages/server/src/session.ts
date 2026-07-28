import { Cause, Context, Data, Effect, Fiber, Ref, Semaphore } from "effect";
import type {
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
  kernelEventLog,
} from "./agent_deps.ts";

export interface SessionManager {
  readonly create: (
    input: { workspace: string; model?: string },
  ) => Effect.Effect<SessionInfo, never, never>;
  readonly get: (
    id: string,
  ) => Effect.Effect<SessionInfo | undefined, never, never>;
  readonly list: () => Effect.Effect<
    ReadonlyArray<SessionInfo>,
    never,
    never
  >;
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
// Per-session model/effort overrides
// ---------------------------------------------------------------------------
// setModel/setEffort reroute a session's FUTURE turns without a server
// reboot. setModel persists the model id into the projection
// (sessions.model), which runAgentTurn already reads per prompt; everything
// else — the rebuilt provider adapter on a cross-provider switch, per-model
// limits, the thinking/effort knobs — lives in this in-memory map. These are
// runtime knobs, not event-sourced state: a server restart falls back to the
// boot defaults (the projection's model column survives, so the model name
// itself is sticky).

interface SessionOverride {
  /** Provider the session's adapter is bound to (post-switch). */
  readonly providerId?: string;
  /** Rebuilt adapter, present only after a cross-provider setModel. */
  readonly provider?: ProviderAdapter;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  /** Model-scoped thinking config (from config.toml [provider.*.models.*]). */
  readonly thinking?: ThinkingConfig;
  /** Explicit effort override; merged over `thinking` at turn time. */
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
// TUI, one-shot, serve — shares one code path and the event log records the
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
    const overrides = yield* Ref.make(new Map<string, SessionOverride>());
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

    const create: SessionManager["create"] = ({ workspace, model }) =>
      Effect.gen(function* () {
        const sessionId = newSessionId();
        const sessionModel = (model ?? infra.defaultModel) || "default";
        yield* kernel.append({
          type: "session.created",
          sessionId,
          data: {
            workspace,
            model: sessionModel,
            ...(infra.defaultContextWindow !== undefined
              ? { contextWindow: infra.defaultContextWindow }
              : {}),
            mcpServers: [...env.mcpServers],
          },
        });
        const info = yield* kernel.projection().pipe(
          Effect.flatMap((p) => Effect.promise(() => p.getSession(sessionId))),
        );
        if (info) return info;
        return {
          sessionId,
          workspace,
          model: sessionModel,
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

    const setStatus = (
      id: string,
      status: SessionInfo["status"],
    ): Effect.Effect<void, never, never> =>
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

    const setModel: SessionManager["setModel"] = (id, modelRef) =>
      Effect.gen(function* () {
        const p = yield* kernel.projection();
        const info = yield* Effect.promise(() => p.getSession(id));
        if (!info) {
          return yield* Effect.fail(new Error(`session ${id} not found`));
        }
        const current = (yield* Ref.get(overrides)).get(id);
        const currentProviderId = current?.providerId ??
          infra.defaultProviderId;

        let modelId = modelRef;
        // Next override; replaces the model-scoped fields wholesale so a
        // switch AWAY from a tuned model clears its limits/thinking (the
        // explicit effort override, being a user knob, survives).
        let next: SessionOverride = {
          ...(current?.effort !== undefined ? { effort: current.effort } : {}),
        };

        if (modelRef.includes("/")) {
          // Full ref: resolve against the boot config for provider + limits.
          if (!infra.config || !infra.makeProvider) {
            return yield* Effect.fail(
              new Error(
                "setModel: provider-qualified ref needs config + provider " +
                  "factory, neither is available in this infra",
              ),
            );
          }
          const config = infra.config;
          const makeProvider = infra.makeProvider;
          const resolved = yield* Effect.try(() =>
            resolveModelRef(config, modelRef)
          );
          modelId = resolved.modelId;
          // Rebuild the adapter only when the provider actually changes; a
          // same-provider switch rides the existing adapter (the model name
          // travels per-request on ChatRequest).
          const provider = resolved.provider.id !== currentProviderId
            ? yield* Effect.tryPromise(() => makeProvider(config, modelRef))
            : current?.provider;
          next = {
            ...next,
            providerId: resolved.provider.id,
            ...(provider !== undefined ? { provider } : {}),
            contextWindow: resolved.model.contextWindow,
            maxTokens: resolved.model.maxOutput,
            ...(thinkingFromModelConfig(resolved.model) !== undefined
              ? { thinking: thinkingFromModelConfig(resolved.model) }
              : {}),
          };
        } else if (infra.config && currentProviderId) {
          // Bare model-id: keep the provider, but pick up the declared
          // per-model limits/thinking when the config knows the pair.
          const resolved = yield* Effect.try(() =>
            resolveModelRef(infra.config!, `${currentProviderId}/${modelRef}`)
          );
          next = {
            ...next,
            providerId: currentProviderId,
            ...(current?.provider !== undefined
              ? { provider: current.provider }
              : {}),
            contextWindow: resolved.model.contextWindow,
            maxTokens: resolved.model.maxOutput,
            ...(thinkingFromModelConfig(resolved.model) !== undefined
              ? { thinking: thinkingFromModelConfig(resolved.model) }
              : {}),
          };
        } else {
          // No config to resolve against (minimal injected infra): just the
          // model name changes; limits/thinking stay at the boot defaults.
          next = current ?? {};
        }

        // Persist the model id: runAgentTurn reads the projection per prompt,
        // so the NEXT turn picks the new model up.
        yield* Effect.promise(() =>
          p.db
            .updateTable("sessions")
            .set({ model: modelId, updated_at: now() })
            .where("session_id", "=", id)
            .execute()
        );
        yield* Ref.update(overrides, (m) => new Map(m).set(id, next));

        return {
          ok: true as const,
          model: modelId,
          ...(next.contextWindow !== undefined
            ? { contextWindow: next.contextWindow }
            : {}),
        };
      });

    const setEffort: SessionManager["setEffort"] = (id, effort) =>
      Effect.gen(function* () {
        const p = yield* kernel.projection();
        const info = yield* Effect.promise(() => p.getSession(id));
        if (!info) {
          return yield* Effect.fail(new Error(`session ${id} not found`));
        }
        yield* Ref.update(overrides, (m) =>
          new Map(m).set(id, { ...m.get(id), effort }));
        return { ok: true as const, effort };
      });

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
        const controller = new AbortController();
        const active: ActiveTurn = {
          kind: "turn",
          token,
          controller,
          phase: "accepting",
          pending: [input],
        };
        state.active = active;
        const fiber = yield* Effect.forkDetach(
          runAgentTurn(sessionId, token, controller),
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
      controller: AbortController,
    ): Effect.Effect<void, never, never> => {
      let termination: TurnTermination = "failed";

      return Effect.gen(function* () {
        const info = yield* kernel.projection().pipe(
          Effect.flatMap((p) =>
            Effect.promise(() => p.getSession(sessionId))
          ),
        );
        const workspace = info?.workspace ?? infra.defaultWorkspace;
        const model = info?.model ?? infra.defaultModel;
        const ov = (yield* Ref.get(overrides)).get(sessionId);
        const provider = ov?.provider ?? infra.provider;
        const contextWindow = ov?.contextWindow ?? infra.defaultContextWindow;
        const maxTokens = ov?.maxTokens ?? infra.defaultMaxTokens;
        const baseThinking = ov?.thinking ?? infra.defaultThinking;
        const thinking = ov?.effort !== undefined
          ? { ...baseThinking, effort: ov.effort }
          : baseThinking;

        const result = yield* runTurn(sessionId, {
          event_log: kernelEventLog(kernel),
          provider,
          tools: infra.tools,
          approvals: kernelApprovalGateway(kernel),
          model,
          workspace,
          emitLive: kernelEmitLive(kernel),
          signal: controller.signal,
          input: turnInputFor(sessionId, token),
          ...(contextWindow !== undefined ? { contextWindow } : {}),
          ...(maxTokens !== undefined ? { maxTokens } : {}),
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
                data: { reason: "turn failed" },
              });
            } else {
              yield* kernel.append({
                type: "turn.aborted",
                sessionId,
                data: { reason: "signal" },
              });
            }
          })
        ),
        Effect.ensuring(
          Effect.gen(function* () {
            yield* setStatus(sessionId, "idle");
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
    // the log, summarizes, and appends a compaction.performed event.
    // Failure isolation mirrors runAgentTurn — a failure becomes an
    // error.occurred event so the JSONL stays the source of truth, with a
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
        const info = yield* kernel.projection().pipe(
          Effect.flatMap((p) => Effect.promise(() => p.getSession(sessionId))),
        );
        const model = info?.model ?? infra.defaultModel;
        // Same provider/model resolution as runAgentTurn: per-session
        // overrides (setModel) win over the boot adapter; the model name
        // comes from the projection, which setModel already updated.
        const ov = (yield* Ref.get(overrides)).get(sessionId);
        const provider = ov?.provider ?? infra.provider;

        yield* compactSession(sessionId, {
          event_log: kernelEventLog(kernel),
          provider,
          model,
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
        const info = yield* kernel.projection().pipe(
          Effect.flatMap((p) => Effect.promise(() => p.getSession(id))),
        );
        const workspace = info?.workspace ?? infra.defaultWorkspace;
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

    return {
      create,
      get,
      list,
      setModel,
      setEffort,
      prompt,
      compact,
      interrupt,
      awaitAll,
    } satisfies SessionManager;
  });
