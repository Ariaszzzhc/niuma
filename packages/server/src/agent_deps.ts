import { Effect, Stream } from "effect";
import type {
  ApprovalDecisionType,
  LiveEvent,
  RecordedEvent,
} from "@niuma/schema";
import type { ProviderAdapter, ThinkingConfig } from "@niuma/provider";
import type {
  PermissionEngine,
  SubagentResult,
  ToolRegistry,
} from "@niuma/tools";
import type {
  ApprovalGateway,
  ApprovalInfo,
  ApprovalOutcome,
  EventLog,
  ToolPipeline,
} from "@niuma/agent";
import { makeToolPipeline as makeAgentToolPipeline } from "@niuma/agent";
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
// approval.requested, parks a Deferred in the kernel's registry, records
// approval.resolved on resume. The HTTP approvals endpoint resolves the
// deferred via Kernel.resolveApproval; gateway.resolve is a redundant
// pass-through kept only to satisfy the ApprovalGateway interface.
// ---------------------------------------------------------------------------

const outcomeOf = (resolved: {
  approvalId: string;
  decision: ApprovalDecisionType;
  feedback?: string;
}): ApprovalOutcome =>
  resolved.feedback !== undefined
    ? { decision: resolved.decision, feedback: resolved.feedback }
    : { decision: resolved.decision };

export const kernelApprovalGateway = (kernel: Kernel): ApprovalGateway => {
  const pending = new Map<string, ApprovalInfo>();
  return {
    ask: (sessionId, req) =>
      kernel.askForApproval(sessionId, req.callId, req.name, req.input).pipe(
        Effect.map((resolved) => outcomeOf(resolved)),
      ),
    resolve: (approvalId, decision, feedback) => {
      void Effect.runPromise(
        kernel.resolveApproval(approvalId, {
          approvalId,
          decision,
          ...(feedback !== undefined ? { feedback } : {}),
        }),
      ).then((ok) => {
        if (ok) pending.delete(approvalId);
      });
    },
    get pending() {
      return pending;
    },
  };
};

// ---------------------------------------------------------------------------
// Tool pipeline adapter: delegates to @niuma/agent's well-tested
// makeToolPipeline, which already implements:
//   - read-only mode dropping bash/write/edit/apply_patch from defs AND
//     rejecting them at run time with a synthetic error result
//   - per-session engine cache (engineFor) so each session gets its own
//     permission state
//   - ApprovalRequest ↔ ApprovalInfo ↔ ApprovalOutcome translation
//   - Optional spawnSubagent wiring (threaded into ToolCtx so the
//     spawn_subagent tool can dispatch to AgentSession.spawnSubagent)
// The legacy PipelineDeps shape (`{registry, engine, workspace}`) keeps
// bootstrap.ts working unchanged; per-session engine factory and subagent
// spawner are wired only when callers pass the optional fields.
// ---------------------------------------------------------------------------

export interface PipelineDeps {
  readonly registry?: ToolRegistry;
  // Shared engine (single-session or stub-MemoryPermissionEngine path).
  // Mutually exclusive with `engineFor`.
  readonly engine?: PermissionEngine;
  // Per-session permission engine factory. Memoised inside the adapter.
  readonly engineFor?: (
    sessionId: string,
    workspace: string,
  ) => PermissionEngine;
  // Optional subagent spawner wired into ToolCtx.spawnSubagent.
  readonly spawnSubagent?: (req: {
    readonly prompt: string;
    readonly mode?: "default" | "read-only";
    readonly parentSessionId: string;
  }) => Promise<SubagentResult>;
  // Retained for backwards compatibility with the previous signature; no
  // longer used because workspace is taken per-call from ToolRunContext.
  readonly workspace?: string;
}

export const makeToolPipeline = (deps: PipelineDeps): ToolPipeline => {
  if (!deps.engine && !deps.engineFor) {
    throw new Error(
      "makeToolPipeline: provide either `engine` or `engineFor`",
    );
  }
  return makeAgentToolPipeline({
    ...(deps.registry !== undefined ? { registry: deps.registry } : {}),
    ...(deps.engine !== undefined ? { engine: deps.engine } : {}),
    ...(deps.engineFor !== undefined ? { engineFor: deps.engineFor } : {}),
    ...(deps.spawnSubagent !== undefined
      ? { spawnSubagent: deps.spawnSubagent }
      : {}),
  });
};

// Convenience re-export so callers can build a ToolPipeline without thinking
// about which package owns the implementation.
export { makeAgentToolPipeline as makeToolPipelineFromAgent };

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
// Infra bundle handed to the SessionManager so it can build RunTurnDeps per
// session without re-resolving provider/tools on every prompt. We deliberately
// do NOT extend @niuma/agent's AgentInfra here — that one bakes in event_log /
// approvals / emitLive because AgentSession consumes them as long-lived
// members; the server builds them per-session from the Kernel (so each
// session's events/approvals land in its own JSONL file).
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
}
