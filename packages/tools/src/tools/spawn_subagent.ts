import { z } from "zod";
import type { Tool, ToolOutput } from "../types.ts";
import { toolOutput } from "../truncate.ts";
import { zodToJsonSchema } from "../jsonSchema.ts";

export const SpawnSubagentInput = z.object({
  prompt: z.string().min(1).describe("Task to hand off to the subagent."),
  mode: z.enum(["default", "read-only"]).optional()
    .describe("Restrict the child to read-only tools; default unrestricted."),
});

export type SpawnSubagentInput = z.infer<typeof SpawnSubagentInput>;

export const spawnSubagentTool: Tool<SpawnSubagentInput> = {
  name: "spawn_subagent",
  def: {
    name: "spawn_subagent",
    description:
      "Spawn a child session to handle a sub-task. Returns the child's final assistant text. Pass `mode: \"read-only\"` to restrict the child to non-mutating tools.",
    parameters: zodToJsonSchema(SpawnSubagentInput),
  },
  accesses: { process: false }, // child runs in the same process — not a separate exec.
  inputSchema: SpawnSubagentInput,
  normalize: (i) => `subagent(${i.mode ?? "default"}): ${truncate(i.prompt, 60)}`,
  async execute(input, ctx): Promise<ToolOutput> {
    const callId = `spawn_subagent:${ctx.sessionId}`;
    if (!ctx.spawnSubagent) {
      return await toolOutput(
        "error: subagent spawning is not wired in this context",
        callId,
        { isError: true },
      );
    }
    try {
      const r = await ctx.spawnSubagent({
        prompt: input.prompt,
        mode: input.mode ?? "default",
        parentSessionId: ctx.sessionId,
      });
      return await toolOutput(r.text || "(empty)", callId);
    } catch (e) {
      return await toolOutput(`error: ${(e as Error).message}`, callId, {
        isError: true,
      });
    }
  },
};

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}