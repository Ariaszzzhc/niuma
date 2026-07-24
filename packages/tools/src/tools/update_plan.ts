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

// In-memory plan store keyed by sessionId.
//
// Persistence semantics: per the @niuma/tools contract, update_plan state is
// in-memory for v0 — it is rebuilt on session restart by replaying the
// event log (the agent's runTurn loop records each tool.call.requested for
// update_plan, so a resuming session can reconstruct the latest plan via
// AgentSession.plan()). The store below is therefore a process-local cache
// only; it must not be treated as authoritative across restarts.
const plans = new Map<string, UpdatePlanInput["items"]>();

export function getPlan(
  sessionId: string,
): UpdatePlanInput["items"] | undefined {
  return plans.get(sessionId);
}

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
    plans.set(ctx.sessionId, input.items);
    ctx.emitProgress?.(callId, `plan updated: ${input.items.length} items`);
    const summary = input.items.map((i) => `[${i.status}] ${i.title}`).join(
      "\n",
    );
    return await toolOutput(summary, callId);
  },
};
