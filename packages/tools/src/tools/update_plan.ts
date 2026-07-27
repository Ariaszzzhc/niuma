import { z } from "zod";
import type { Tool, ToolOutput } from "../types.ts";
import { toolOutput } from "../truncate.ts";
import { zodToJsonSchema } from "../json_schema.ts";

// deno-lint-ignore no-slow-types
const PlanStatus = z.enum(["pending", "in_progress", "done"]);

// deno-lint-ignore no-slow-types
const PlanItem = z.object({
  title: z.string().min(1),
  status: PlanStatus,
});

// deno-lint-ignore no-slow-types
const UpdatePlanInput_ = z.object({
  items: z.array(PlanItem).describe(
    "New full plan — overwrites the previous plan.",
  ),
});

export type UpdatePlanInput = z.infer<typeof UpdatePlanInput_>;
export const UpdatePlanInput: z.ZodType<UpdatePlanInput> = UpdatePlanInput_;

export const updatePlanTool: Tool<UpdatePlanInput> = {
  name: "update_plan",
  def: {
    name: "update_plan",
    description:
      "Overwrite the session's plan with a new ordered list. Used to track progress on multi-step tasks.",
    parameters: zodToJsonSchema(UpdatePlanInput),
  },
  accesses: {},
  inputSchema: UpdatePlanInput,
  normalize: (i) => `plan(${i.items.length} items)`,
  async execute(input, ctx): Promise<ToolOutput> {
    const callId = `update_plan:${ctx.sessionId}`;
    // Basic invariant checks.
    const inProgress =
      input.items.filter((i) => i.status === "in_progress").length;
    if (inProgress > 1) {
      return await toolOutput(
        `error: at most one item may be in_progress; got ${inProgress}`,
        callId,
        { isError: true },
      );
    }
    ctx.emitProgress?.(callId, `plan updated: ${input.items.length} items`);
    const summary = input.items.map((i) => `[${i.status}] ${i.title}`).join(
      "\n",
    );
    return await toolOutput(summary, callId);
  },
};
