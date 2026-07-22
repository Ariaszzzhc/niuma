import type {
  Accesses,
  PermissionEngine,
  PreparedCall,
  Tool,
  ToolCallRecord,
  ToolCtx,
  ToolMode,
  ToolOutput,
} from "./types.ts";
import { READ_ONLY_ALLOWED } from "./types.ts";
import { authorize } from "./authorize.ts";
import { schedule, type ScheduledJob } from "./scheduler.ts";
import { resolvePath } from "./path.ts";
import { isWithinRoot } from "./pathUtil.ts";

export interface PipelineOptions {
  /** Tools indexed by name. */
  tools: ReadonlyMap<string, Tool>;
  /** Permission engine instance. */
  engine: PermissionEngine;
  /** Tool ctx (cwd, sessionId, signal, ask, ...). */
  ctx: ToolCtx;
  /**
   * Filesystem root for path normalisation. Defaults to `ctx.cwd`. Tools
   * that escape this root are detected AND forced through Ask even when
   * the policy chain would otherwise allow them.
   */
  workspaceRoot?: string;
  /**
   * Tool-exposure mode. `read-only` short-circuits any mutating tool
   * (anything outside READ_ONLY_ALLOWED) with an isError result — used
   * by the agent to keep subagents from touching the workspace.
   */
  mode?: ToolMode;
}

/**
 * prepare → authorize → schedule → execute. Returns one output per input
 * record, in the original model-call order.
 *
 * Pipeline semantics:
 *   1. `prepare` validates input (zod), resolves declared paths against the
 *      workspace root, populates `accesses` with the concrete paths (so the
 *      scheduler can serialise write/write + write/read conflicts on real
 *      files), flags escapes → forces Ask.
 *   2. `authorize` consults the engine; Ask is routed through `ctx.ask`
 *      with once/always/reject semantics (reject → isError result).
 *      Escapes additionally force Ask regardless of the engine verdict.
 *   3. `schedule` runs the batch through the resource scheduler.
 *   4. `execute` is invoked by the scheduler; the per-tool run function
 *      traps errors, records wall-clock duration, and returns isError
 *      results on failure.
 */
export async function runPipeline(
  calls: ReadonlyArray<ToolCallRecord>,
  opts: PipelineOptions,
): Promise<ToolOutput[]> {
  const wsRoot = opts.workspaceRoot ?? opts.ctx.cwd;
  const mode: ToolMode = opts.mode ?? "full";
  const errors: (ToolOutput | null)[] = calls.map(() => null);
  const prepared: PreparedCall[] = [];

  // 1. Prepare — validate, resolve paths, compute accesses.
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    const tool = opts.tools.get(call.name);
    if (!tool) {
      errors[i] = { content: `unknown tool: ${call.name}`, isError: true, callId: call.callId };
      continue;
    }
    // Read-only mode: short-circuit anything that isn't on the allowlist.
    if (mode === "read-only" && !READ_ONLY_ALLOWED.has(call.name)) {
      errors[i] = {
        content:
          `denied: tool '${call.name}' is not available in read-only mode`,
        isError: true,
        callId: call.callId,
      };
      continue;
    }
    const parsed = tool.inputSchema.safeParse(call.input);
    if (!parsed.success) {
      errors[i] = {
        content:
          `invalid input for ${call.name}: ${
            parsed.error.issues
              .map((iss) => `${iss.path.join(".")}: ${iss.message}`)
              .join("; ")
          }`,
        isError: true,
        callId: call.callId,
      };
      continue;
    }

    // Resolve declared paths against the workspace root and merge them into
    // the per-call accesses so the scheduler + authoriser see real paths.
    const accesses = mergeAccesses(tool, parsed.data, opts.ctx.cwd, wsRoot);
    const escapes = anyEscapes(accesses, wsRoot);

    const pattern = tool.normalize ? tool.normalize(parsed.data) : call.name;
    prepared.push({
      callId: call.callId,
      name: call.name,
      input: parsed.data as never,
      pattern,
      accesses: { ...tool.accesses, ...accesses },
      escapesWorkspace: escapes,
    });
  }

  // 2. Authorize (in original order; allowed calls become scheduled jobs).
  const jobs: ScheduledJob<ToolOutput>[] = [];
  for (let i = 0; i < calls.length; i++) {
    if (errors[i]) continue;
    const call = calls[i];
    const prep = prepared.find((p) => p.callId === call.callId)!;
    const verdict = await authorize(
      prep,
      opts.tools,
      {
        engine: opts.engine,
        ctx: opts.ctx,
      },
    );
    if (verdict.verdict === "deny") {
      errors[i] = {
        content: `denied: ${verdict.reason ?? "policy"}`,
        isError: true,
        callId: call.callId,
      };
      continue;
    }
    const tool = opts.tools.get(call.name)!;
    const input = prep.input;
    const ctxRef = opts.ctx;
    const callId = call.callId;
    jobs.push({
      index: i,
      id: callId,
      accesses: prep.accesses,
      run: async () => {
        const t0 = Date.now();
        try {
          const out = await tool.execute(input as never, ctxRef);
          return {
            ...out,
            callId,
            durationMs: Date.now() - t0,
          };
        } catch (e) {
          return {
            content: `error: ${e instanceof Error ? e.message : String(e)}`,
            isError: true,
            callId,
            durationMs: Date.now() - t0,
          };
        }
      },
    });
  }

  // 3+4. Schedule + execute.
  const executed = await schedule(jobs, { signal: opts.ctx.signal });

  // Stitch back into the original order, filling pre-flight errors.
  const results: ToolOutput[] = new Array(calls.length);
  for (let i = 0; i < calls.length; i++) {
    if (errors[i]) {
      results[i] = errors[i]!;
    } else {
      results[i] = executed[i];
    }
  }
  return results;
}

/**
 * Resolve the tool's declared path footprint against the workspace and
 * return a merged `Accesses` carrying the concrete absolute paths. We
 * swallow PathError here — the tool's own execute() will surface a friendly
 * error if the path is genuinely out of bounds, but at prepare time we want
 * the scheduler to be able to serialise on the literal string the tool
 * normalised to.
 */
function mergeAccesses(
  tool: Tool,
  input: unknown,
  cwd: string,
  root: string,
): Accesses {
  if (!tool.paths) return {};
  let declared: { read?: readonly string[]; write?: readonly string[] } = {};
  try {
    declared = tool.paths(input as never) ?? {};
  } catch {
    return {};
  }
  const read: string[] = [];
  const write: string[] = [];
  for (const p of declared.read ?? []) read.push(normaliseFor(p, cwd, root));
  for (const p of declared.write ?? []) write.push(normaliseFor(p, cwd, root));
  return { files: { read, write } };
}

function normaliseFor(path: string, cwd: string, root: string): string {
  try {
    return resolvePath(cwd, path, root).abs;
  } catch {
    // Path escapes the root — keep the raw form so the scheduler still has
    // *something* to conflict-match on; the escape check below flags it.
    return path;
  }
}

function anyEscapes(accesses: Accesses, root: string): boolean {
  const all = [
    ...(accesses.files?.read ?? []),
    ...(accesses.files?.write ?? []),
  ];
  for (const p of all) {
    if (!isWithinRoot("", p, root)) return true;
  }
  return false;
}
