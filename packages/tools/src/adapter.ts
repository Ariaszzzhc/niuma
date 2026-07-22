import { Effect } from "effect";
import type { ToolDef as ProviderToolDef } from "@niuma/provider";
import type { ToolResultContent } from "@niuma/schema";
import { runPipeline } from "./pipeline.ts";
import { ToolRegistry, toToolMap } from "./registry.ts";
import { MemoryPermissionEngine, type PermissionEngine } from "./permission.ts";
import type {
  ApprovalDecision,
  ApprovalInfo,
  ToolCallRecord,
  ToolCtx,
  ToolMode,
  ToolOutput,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Agent-port shapes.
//
// The agent package (@niuma/agent) declares its own `ToolPipeline` / `ToolRun-
// Context` / `ToolRunResult` types in src/deps.ts. We re-declare them here
// with structurally-identical shapes so this adapter satisfies the agent's
// port without a runtime dependency cycle (agent depends on tools for the
// concrete implementation; tools cannot import agent for the types).
// ---------------------------------------------------------------------------

/** User-facing approval reply. */
export type ApprovalDecisionType = "once" | "always" | "reject";

export interface ApprovalRequest {
  readonly callId: string;
  readonly name: string;
  readonly input: unknown;
}

export interface ApprovalOutcome {
  readonly decision: ApprovalDecisionType;
  readonly feedback?: string;
}

/** Closure supplied by the agent for spawning a child session. */
export type SpawnSubagentFn = (req: {
  readonly prompt: string;
  readonly mode?: "default" | "read-only";
  readonly parentSessionId: string;
}) => Promise<{ readonly sessionId: string; readonly text: string }>;

export interface ToolRunContext {
  readonly sessionId: string;
  readonly workspace: string;
  readonly mode?: ToolMode;
  readonly signal?: AbortSignal;
  readonly ask: (req: ApprovalRequest) => Effect.Effect<ApprovalOutcome>;
  readonly emitProgress?: (callId: string, message?: string) => void;
  readonly spawnSubagent?: SpawnSubagentFn;
}

export interface ToolCallRequest {
  readonly callId: string;
  readonly name: string;
  readonly input: unknown;
}

export interface ToolRunResult {
  readonly callId: string;
  readonly content: ToolResultContent;
  readonly isError: boolean;
  readonly durationMs: number;
}

export interface ToolPipeline {
  readonly defs: (mode: ToolMode) => ReadonlyArray<ProviderToolDef>;
  readonly run: (
    batch: ReadonlyArray<ToolCallRequest>,
    ctx: ToolRunContext,
  ) => Effect.Effect<ReadonlyArray<ToolRunResult>>;
}

// ---------------------------------------------------------------------------
// Adapter implementation.
// ---------------------------------------------------------------------------

export interface MakeToolPipelineOptions {
  /** Tool registry backing the pipeline. Defaults to a fresh builtins set. */
  registry?: ToolRegistry;
  /** Permission engine. Defaults to a MemoryPermissionEngine seeded with cwd. */
  engine?: PermissionEngine;
  /**
   * Workspace root for path normalisation. Defaults to the workspace passed
   * to each `run()` call (which is what the agent supplies via ToolRunContext).
   */
  workspaceRoot?: string;
}

/**
 * Build a `ToolPipeline` (the agent package's port) backed by @niuma/tools'
 * prepare→authorize→schedule→execute implementation.
 *
 * Bridging notes:
 *   - `defs(mode)` filters the registry through the read-only allowlist.
 *   - `run(batch, ctx)` converts each ApprovalRequest (from the agent) to an
 *     ApprovalInfo (what the tools' ctx.ask expects), runs the Effect-
 *     returning agent ask through Effect.runPromise, and casts the
 *     ApprovalOutcome back into an ApprovalDecision.
 *   - Each ToolOutput is enriched with callId + durationMs by the pipeline;
 *     the adapter only forwards them. ToolOutput.content (string) is already
 *     a valid ToolResultContent (string | TextResultBlock[]).
 */
export function makeToolPipeline(
  opts: MakeToolPipelineOptions = {},
): ToolPipeline {
  const registry = opts.registry ?? new ToolRegistry();
  const engine = opts.engine ?? new MemoryPermissionEngine();
  const fixedRoot = opts.workspaceRoot;

  const defs = (mode: ToolMode): ReadonlyArray<ProviderToolDef> =>
    registry.toToolDefs({ mode }).map((d) => ({
      name: d.name,
      ...(d.description ? { description: d.description } : {}),
      ...(d.parameters ? { parameters: d.parameters } : {}),
    }));

  const run = (
    batch: ReadonlyArray<ToolCallRequest>,
    ctx: ToolRunContext,
  ): Effect.Effect<ReadonlyArray<ToolRunResult>> =>
    Effect.gen(function* () {
      // Pre-bake an input-by-callId map so the ask adapter can recover the
      // raw tool input the agent's ApprovalRequest expects.
      const inputById = new Map<string, unknown>();
      for (const c of batch) inputById.set(c.callId, c.input);

      const toolCtx: ToolCtx = {
        cwd: ctx.workspace,
        sessionId: ctx.sessionId,
        signal: ctx.signal ?? new AbortController().signal,
        ask: (info: ApprovalInfo): Promise<ApprovalDecision> => {
          const req: ApprovalRequest = {
            callId: info.callId,
            name: info.name,
            input: inputById.get(info.callId) ?? info.detail ?? info.pattern,
          };
          return Effect.runPromise(ctx.ask(req)).then(
            (o): ApprovalDecision => ({
              decision: o.decision,
              ...(o.feedback !== undefined ? { feedback: o.feedback } : {}),
            }),
          );
        },
        ...(ctx.emitProgress ? { emitProgress: ctx.emitProgress } : {}),
        ...(ctx.spawnSubagent ? { spawnSubagent: ctx.spawnSubagent } : {}),
      };

      const calls: ToolCallRecord[] = batch.map((c) => ({
        callId: c.callId,
        name: c.name,
        input: c.input,
      }));

      const outputs: ToolOutput[] = yield* Effect.promise(() =>
        runPipeline(calls, {
          tools: toToolMap(registry.all()),
          engine,
          ctx: toolCtx,
          ...(fixedRoot !== undefined ? { workspaceRoot: fixedRoot } : {}),
          mode: ctx.mode ?? "full",
        })
      );

      const results: ToolRunResult[] = outputs.map((o, i) => ({
        callId: o.callId ?? batch[i]?.callId ?? "",
        content: o.content,
        isError: !!o.isError,
        durationMs: o.durationMs ?? 0,
      }));

      return results;
    });

  return { defs, run };
}
