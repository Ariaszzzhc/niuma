import { Effect } from "effect";
import type { ToolDef as ProviderToolDef } from "@niuma/provider";
import type {
  ApprovalDecision,
  ApprovalInfo,
  PermissionEngine,
  SubagentResult,
  Tool,
  ToolOutput,
} from "@niuma/tools";
import { runPipeline, ToolRegistry } from "@niuma/tools";
import type {
  ApprovalOutcome,
  ApprovalRequest,
  ToolCallRequest,
  ToolMode,
  ToolPipeline,
  ToolRunContext,
  ToolRunResult,
} from "./deps.ts";

// Tools that mutate the workspace or shell out — dropped from `defs` and
// rejected at `run` time when the session is in read-only mode (subagents).
const MUTATING_TOOLS = new Set([
  "bash",
  "write",
  "edit",
  "apply_patch",
]);

export interface MakeToolPipelineOptions {
  // Optional override of the tool registry; defaults to builtins().
  readonly registry?: ToolRegistry;
  // Permission engine driving authorize(). Used when one engine serves every
  // session (tests, single-session CLI). Mutually exclusive with `engineFor`.
  readonly engine?: PermissionEngine;
  // Per-session permission engine factory. Required for multi-session runs
  // (the @niuma/permission engine is constructed per-cwd and holds per-session
  // rule state). Memorable; the adapter memoises by sessionId.
  readonly engineFor?: (
    sessionId: string,
    workspace: string,
  ) => PermissionEngine;
  // Optional subagent spawner — when present, threaded into ToolCtx so the
  // spawn_subagent tool can dispatch to AgentSession.spawnSubagent.
  readonly spawnSubagent?: (req: {
    readonly prompt: string;
    readonly mode?: "default" | "read-only";
    readonly parentSessionId: string;
  }) => Promise<SubagentResult>;
  // Max parallel tool calls; forwarded to the scheduler (default 8).
  readonly concurrency?: number;
}

const isReadOnly = (mode: ToolMode): boolean => mode === "read-only";

/**
 * Adapter from the agent's ToolPipeline port to @niuma/tools' runPipeline.
 *
 * - `defs(mode)` projects the registry to ProviderToolDef[], dropping
 *   bash/write/edit/apply_patch for read-only sessions (subagents).
 * - `run(batch, ctx)` wraps runPipeline in Effect.promise, translating the
 *   agent's port types (ToolCallRequest/ApprovalRequest/ApprovalOutcome) into
 *   the tools' (ToolCallRecord/ApprovalInfo/ApprovalDecision) and back
 *   (ToolOutput → ToolRunResult, with content string promoted to the schema's
 *   ToolResultContent). Read-only mode short-circuits mutating calls with a
 *   synthetic error result rather than reaching the pipeline.
 */
export function makeToolPipeline(
  opts: MakeToolPipelineOptions,
): ToolPipeline {
  const registry = opts.registry ?? new ToolRegistry();
  const tools = registry.all();
  const toolMap = new Map<string, Tool>(tools.map((t) => [t.name, t]));
  // Per-session engine cache so repeat batches in the same session reuse the
  // same engine (and its remembered "always" rules).
  const engineCache = new Map<string, PermissionEngine>();
  const engineForCtx = (ctx: ToolRunContext): PermissionEngine => {
    if (opts.engine) return opts.engine;
    if (!opts.engineFor) {
      throw new Error(
        "makeToolPipeline: either `engine` or `engineFor` must be provided",
      );
    }
    const cached = engineCache.get(ctx.sessionId);
    if (cached) return cached;
    const fresh = opts.engineFor(ctx.sessionId, ctx.workspace);
    engineCache.set(ctx.sessionId, fresh);
    return fresh;
  };

  const defs = (mode: ToolMode): ReadonlyArray<ProviderToolDef> => {
    const out: ProviderToolDef[] = [];
    for (const t of tools) {
      if (isReadOnly(mode) && MUTATING_TOOLS.has(t.name)) continue;
      const def: ProviderToolDef = {
        name: t.def.name,
        ...(t.def.description !== undefined
          ? { description: t.def.description }
          : {}),
        ...(t.def.parameters !== undefined
          ? { parameters: t.def.parameters }
          : {}),
      };
      out.push(def);
    }
    return out;
  };

  const run = (
    batch: ReadonlyArray<ToolCallRequest>,
    ctx: ToolRunContext,
  ): Effect.Effect<ReadonlyArray<ToolRunResult>> =>
    Effect.promise(async () => {
      const start = Date.now();
      const readOnly = isReadOnly(ctx.mode);

      // Read-only sessions reject mutating calls up front with a synthetic
      // error result. Non-mutating calls flow through normally.
      if (readOnly) {
        const results: ToolRunResult[] = [];
        const surviving: ToolCallRequest[] = [];
        for (const c of batch) {
          if (MUTATING_TOOLS.has(c.name)) {
            results.push({
              callId: c.callId,
              content: `Tool ${c.name} is not available in read-only mode`,
              isError: true,
              durationMs: 0,
            });
          } else {
            surviving.push(c);
          }
        }
        if (surviving.length === 0) return results;
        const ran = await executeBatch(
          surviving,
          ctx,
          engineForCtx(ctx),
          opts,
          toolMap,
        );
        const byId = new Map(ran.map((r) => [r.callId, r]));
        return batch.map((c) =>
          results.find((r) => r.callId === c.callId) ??
            byId.get(c.callId) ??
            syntheticError(c.callId, "tool not executed", start)
        );
      }

      return await executeBatch(batch, ctx, engineForCtx(ctx), opts, toolMap);
    });

  return { defs, run };
}

async function executeBatch(
  calls: ReadonlyArray<ToolCallRequest>,
  ctx: ToolRunContext,
  engine: PermissionEngine,
  opts: MakeToolPipelineOptions,
  toolMap: Map<string, Tool>,
): Promise<ToolRunResult[]> {
  const start = Date.now();
  const inputByCallId = new Map<string, unknown>();
  for (const c of calls) inputByCallId.set(c.callId, c.input);

  // Bridge the agent's approval callback (Effect<ApprovalOutcome>) to the
  // tools' synchronous ask(ApprovalInfo) → Promise<ApprovalDecision>.
  const ask = (info: ApprovalInfo): Promise<ApprovalDecision> => {
    const req: ApprovalRequest = {
      callId: info.callId,
      name: info.name,
      input: inputByCallId.get(info.callId),
    };
    return Effect.runPromise(ctx.ask(req)).then(
      (outcome: ApprovalOutcome): ApprovalDecision => ({
        decision: outcome.decision,
        ...(outcome.feedback !== undefined
          ? { feedback: outcome.feedback }
          : {}),
      }),
    );
  };

  const toolCtx = {
    cwd: ctx.workspace,
    sessionId: ctx.sessionId,
    signal: ctx.signal ?? new AbortController().signal,
    ask,
    ...(ctx.emitProgress !== undefined
      ? { emitProgress: ctx.emitProgress }
      : {}),
    ...(opts.spawnSubagent !== undefined
      ? { spawnSubagent: opts.spawnSubagent }
      : {}),
  } satisfies import("@niuma/tools").ToolCtx;

  const pipelineOpts: import("@niuma/tools").PipelineOptions = {
    tools: toolMap,
    engine,
    ctx: toolCtx,
    workspaceRoot: ctx.workspace,
  };

  let outputs: ToolOutput[];
  try {
    outputs = await runPipeline(
      calls.map((c) => ({ callId: c.callId, name: c.name, input: c.input })),
      pipelineOpts,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return calls.map((c) => syntheticError(c.callId, msg, start));
  }

  return outputs.map((out, i) => {
    const c = calls[i]!;
    return {
      callId: c.callId,
      content: out.content,
      isError: out.isError === true,
      durationMs: Date.now() - start,
    } satisfies ToolRunResult;
  });
}

const syntheticError = (
  callId: string,
  message: string,
  start: number,
): ToolRunResult => ({
  callId,
  content: message,
  isError: true,
  durationMs: Date.now() - start,
});
