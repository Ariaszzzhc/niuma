import { Cause, Context, Data, Effect, Fiber, Layer, Ref } from "effect";
import type {
  Part,
  SessionInfo,
  SessionStatus,
  StopReason,
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
  readonly incrementMessageCount: (
    id: string,
    by: number,
  ) => Effect.Effect<void, never, never>;
  readonly prompt: (
    id: string,
    parts: ReadonlyArray<Part>,
  ) => Effect.Effect<void, never, never>;
  /** Compact the session's history in the background (the /compact command).
   * Fails with TurnInFlightError while a turn/compaction is running;
   * otherwise forks compactSession (@niuma/agent) and returns immediately —
   * the outcome lands as a compaction.performed event (or nothing, when the
   * history is too short to be worth folding). */
  readonly compact: (
    id: string,
  ) => Effect.Effect<{ accepted: true }, TurnInFlightError, never>;
  readonly interrupt: (id: string) => Effect.Effect<void, never, never>;
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

export const makeSessionManager = (
  infra: SessionManagerInfra,
  env: SessionManagerEnv = { mcpServers: [] },
): Effect.Effect<SessionManager, never, Kernel> =>
  Effect.gen(function* () {
    const kernel = yield* Kernel;
    const inflight = yield* Ref.make(
      new Map<string, Fiber.Fiber<unknown, unknown>>(),
    );
    const overrides = yield* Ref.make(new Map<string, SessionOverride>());

    const create: SessionManager["create"] = ({ workspace, model }) =>
      Effect.gen(function* () {
        const sessionId = newSessionId();
        yield* kernel.append({
          type: "session.created",
          sessionId,
          data: {
            workspace,
            model,
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

        // Persist the model id (mirrors setStatus): runAgentTurn reads the
        // projection per prompt, so the NEXT turn picks the new model up.
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
          Effect.flatMap((p) =>
            Effect.promise(() => p.getSession(sessionId))
          ),
        );
        const workspace = info?.workspace ?? infra.defaultWorkspace;
        const model = info?.model ?? infra.defaultModel;
        // Per-session overrides (setModel/setEffort) win over the boot
        // defaults; the model name itself comes from the projection, which
        // setModel already updated.
        const ov = (yield* Ref.get(overrides)).get(sessionId);
        const provider = ov?.provider ?? infra.provider;
        const contextWindow = ov?.contextWindow ?? infra.defaultContextWindow;
        const maxTokens = ov?.maxTokens ?? infra.defaultMaxTokens;
        const baseThinking = ov?.thinking ?? infra.defaultThinking;
        const thinking = ov?.effort !== undefined
          ? { ...baseThinking, effort: ov.effort }
          : baseThinking;

        // Record the user message before sampling — runTurn drains its steer
        // queue at each loop top but does not prepend an initial user.message.
        // A `/name args` prompt is first expanded against the custom command
        // templates; the typed input survives as sourceText for display.
        const expanded = yield* expandSlashCommand(infra, workspace, parts);
        yield* kernel.append({
          type: "user.message",
          sessionId,
          data: {
            parts: [...expanded.parts],
            ...(expanded.sourceText !== undefined
              ? { sourceText: expanded.sourceText }
              : {}),
          },
        });

        const event_log = kernelEventLog(kernel);
        const approvals = kernelApprovalGateway(kernel);
        const emitLive = kernelEmitLive(kernel);

        yield* runTurn(sessionId, {
          event_log,
          provider,
          tools: infra.tools,
          approvals,
          model,
          workspace,
          emitLive,
          ...(contextWindow !== undefined ? { contextWindow } : {}),
          ...(maxTokens !== undefined ? { maxTokens } : {}),
          ...(thinking !== undefined ? { thinking } : {}),
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
            })
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
          })
        ),
      );

    // Register a background fiber for a session and drop it from the
    // inflight map once it finishes, so interrupt/awaitAll/compact don't
    // observe stale entries (shared by prompt and compact).
    const registerInflight = (
      id: string,
      fiber: Fiber.Fiber<unknown, unknown>,
    ): Effect.Effect<void, never, never> =>
      Effect.gen(function* () {
        yield* Ref.update(inflight, (m) => new Map(m).set(id, fiber));
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

    // Background compaction (the /compact command): compactSession replays
    // the log, summarizes, and appends a compaction.performed event.
    // Failure isolation mirrors runAgentTurn — a failure becomes an
    // error.occurred event so the JSONL stays the source of truth, with a
    // last-resort console.error for dep-wiring panics. (compactSession
    // itself already falls back to the template summary when the LLM call
    // fails, so reaching catchCause means replay/append broke.)
    const runCompaction = (
      sessionId: string,
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
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            console.error(`runCompaction(${sessionId}) crashed:`, cause);
          })
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
        yield* registerInflight(id, fiber);
      });

    const compact: SessionManager["compact"] = (id) =>
      Effect.gen(function* () {
        // A turn (or an earlier compaction) is still writing to this log —
        // refuse rather than interleave replay/append with live turn events.
        const existing = (yield* Ref.get(inflight)).get(id);
        if (existing) {
          return yield* Effect.fail(new TurnInFlightError({ sessionId: id }));
        }
        const fiber = yield* Effect.forkDetach(runCompaction(id));
        yield* registerInflight(id, fiber);
        return { accepted: true as const };
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
      setModel,
      setEffort,
      incrementMessageCount,
      prompt,
      compact,
      interrupt,
      awaitAll,
    } satisfies SessionManager;
  });

export const SessionManagerLive = (
  infra: SessionManagerInfra,
  env?: SessionManagerEnv,
): Layer.Layer<SessionManager, never, Kernel> =>
  Layer.effect(SessionManager, makeSessionManager(infra, env));
