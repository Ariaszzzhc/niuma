import { z } from "zod";
import type { Tool, ToolOutput } from "../types.ts";
import { execCapture } from "../exec.ts";
import { toolOutput } from "../truncate.ts";
import { zodToJsonSchema } from "../jsonSchema.ts";

export const BashInput = z.object({
  command: z.string().min(1).describe("Shell command to execute."),
  timeout_ms: z.number().int().positive().optional()
    .describe("Override the default 120s timeout."),
});

export type BashInput = z.infer<typeof BashInput>;

const DEFAULT_TIMEOUT_MS = 120_000;

export const bashTool: Tool<BashInput> = {
  name: "bash",
  def: {
    name: "bash",
    description:
      "Run a shell command. Captures stdout+stderr (each capped), exits non-zero on failure. Use `timeout_ms` for long-running commands; default 120s.",
    parameters: zodToJsonSchema(BashInput),
  },
  accesses: { process: true },
  inputSchema: BashInput,
  normalize: (i) => i.command,
  async execute(input, ctx): Promise<ToolOutput> {
    const callId = `bash:${ctx.sessionId}:${shortId(input.command)}`;
    const res = await execCapture(input.command, {
      cwd: ctx.cwd,
      timeoutMs: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      signal: ctx.signal,
    });
    const parts: string[] = [];
    if (res.stdout) parts.push(res.stdout);
    if (res.stderr) parts.push(`[stderr]\n${res.stderr}`);
    if (res.timedOut) {
      parts.push(`[timed out after ${input.timeout_ms ?? DEFAULT_TIMEOUT_MS}ms]`);
    }
    if (res.aborted) {
      parts.push("[aborted]");
    }
    if (res.truncated) parts.push("[output truncated; some bytes discarded]");
    const body = parts.join("\n");
    // Aborted is a cancellation, not a command failure — surface the tag and
    // let the scheduler's grace-timer logic own the isError abort result.
    if (res.code !== 0 && !res.timedOut && !res.aborted) {
      const out = await toolOutput(
        body ? `${body}\n[exit ${res.code}]` : `[exit ${res.code}]`,
        callId,
      );
      return { ...out, isError: true };
    }
    return await toolOutput(body || "[no output]", callId);
  },
};

function shortId(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).slice(0, 8);
}