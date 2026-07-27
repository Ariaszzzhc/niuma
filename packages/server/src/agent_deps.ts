import { Effect, Stream } from "effect";
import type { LiveEvent, RecordedEvent } from "@niuma/schema";
import type { ProviderAdapter, ThinkingConfig } from "@niuma/provider";
import type { NiumaConfig } from "@niuma/config";
import type {
  ApprovalGateway,
  ApprovalOutcome,
  EventLog,
  ToolPipeline,
} from "@niuma/agent";
import type { Kernel } from "./kernel.ts";

// ---------------------------------------------------------------------------
// EventLog adapter: exposes kernel.append/replay as the agent's EventLog port.
// The kernel assigns seq/ts; the agent just hands over the type+data envelope.
// ---------------------------------------------------------------------------

export const kernelEventLog = (kernel: Kernel): EventLog => ({
  append: (sessionId, input) =>
    kernel.append(
      {
        ...input,
        sessionId,
      } as Parameters<typeof kernel.append>[0],
    ),
  replay: (sessionId) =>
    Effect.gen(function* () {
      const out: RecordedEvent[] = [];
      yield* kernel.replay(sessionId).pipe(
        Stream.runForEach((e) => {
          out.push(e);
          return Effect.void;
        }),
      );
      return out;
    }),
});

// ---------------------------------------------------------------------------
// Approval gateway: delegate `ask` to Kernel.askForApproval, which records
// approval.requested, parks a Deferred in the kernel's registry, and records
// approval.resolved after the HTTP approvals endpoint resumes it.
// ---------------------------------------------------------------------------

const outcomeOf = (resolved: {
  approvalId: string;
  decision: ApprovalOutcome["decision"];
  feedback?: string;
}): ApprovalOutcome =>
  resolved.feedback !== undefined
    ? { decision: resolved.decision, feedback: resolved.feedback }
    : { decision: resolved.decision };

export const kernelApprovalGateway = (kernel: Kernel): ApprovalGateway => ({
  ask: (sessionId, req) =>
    kernel.askForApproval(sessionId, req.callId, req.name, req.input).pipe(
      Effect.map(outcomeOf),
    ),
});

// ---------------------------------------------------------------------------
// Live sink: forward live events to the kernel's bus (SSE).
// ---------------------------------------------------------------------------

export const kernelEmitLive = (
  kernel: Kernel,
): (event: LiveEvent) => void => {
  return (event) => {
    void Effect.runPromise(kernel.live(event));
  };
};

// ---------------------------------------------------------------------------
// Infra bundle handed to the server's SessionManager so it can build
// RunTurnDeps per session without re-resolving provider/tools on every prompt.
// ---------------------------------------------------------------------------

export interface AgentInfra {
  readonly provider: ProviderAdapter;
  readonly tools: ToolPipeline;
  readonly defaultModel: string;
  readonly defaultWorkspace: string;
  /** Per-model limits from config.toml ([provider.*.models.*]); the agent
   * loop falls back to its own defaults when unset. */
  readonly defaultContextWindow?: number;
  readonly defaultMaxTokens?: number;
  /** Per-model thinking/reasoning config from config.toml
   * (thinking_effort/thinking_keep), projected verbatim into every
   * runTurn call. Mirrors @niuma/agent's AgentInfra.defaultThinking. */
  readonly defaultThinking?: ThinkingConfig;
  /** Global niuma config dir (niumaPaths().config) — level-1 root for custom
   * slash command discovery (commands/*.md). Absent in injected test infra;
   * command lookup then just skips the user level. */
  readonly globalConfigDir?: string;
  /** Merged niuma config — needed to resolve `provider/model-id` refs at
   * runtime (SessionManager.setModel). Absent in minimal test infra;
   * provider-qualified switches then fail fast with a clear error. */
  readonly config?: NiumaConfig;
  /** Provider adapter factory for runtime cross-provider switches
   * (bootstrap wires makeProviderFromConfig; tests inject a fake). Called
   * only when setModel's ref names a provider different from the session's
   * current one. */
  readonly makeProvider?: (
    config: NiumaConfig,
    ref: string,
  ) => Promise<ProviderAdapter>;
  /** Provider id of the boot adapter (from the resolved default model ref);
   * the baseline for "did the provider change" on setModel. */
  readonly defaultProviderId?: string;
}
