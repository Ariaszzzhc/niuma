import { z } from "zod";
import { expandCommandTemplate, type SkillDef } from "@niuma/config";
import type { Tool, ToolOutput } from "../types.ts";
import { toolOutput } from "../truncate.ts";
import { zodToJsonSchema } from "../json_schema.ts";

// ---------------------------------------------------------------------------
// `skill` tool: load a discovered skill's full instructions by name.
//
// The skills map is discovered once at bootstrap (packages/config
// loadSkills) and captured by this factory closure, so the tool is a pure
// in-memory lookup — zero IO — and ToolContext gains no new member. The
// tool is registered by the server bootstrap (registry.register), not by
// builtins(), because its behaviour depends on the per-process skills map.
//
// Optional `args` are expanded exactly like custom slash command arguments
// ($ARGUMENTS whole string, $1..$N positional with the highest swallowing
// the rest, no-placeholder templates get args appended) via
// @niuma/config's expandCommandTemplate — one expansion semantics shared by
// both surfaces.
// ---------------------------------------------------------------------------

// deno-lint-ignore no-slow-types
const SkillInput_ = z.object({
  name: z.string().min(1).describe(
    "Name of the skill to load (from the available skills listing).",
  ),
  args: z.string().optional().describe(
    "Optional argument string expanded into the skill body: $ARGUMENTS is " +
      "replaced verbatim, $1..$N take positional arguments (the highest " +
      "swallows the rest); with no placeholders the args are appended.",
  ),
});

export type SkillInput = z.infer<typeof SkillInput_>;
export const SkillInput: z.ZodType<SkillInput> = SkillInput_;

/** Cap on the available-names listing in not-found errors. */
const NOT_FOUND_LIST_CAP = 20;

export const makeSkillTool = (
  skills: ReadonlyMap<string, SkillDef>,
): Tool<SkillInput> => ({
  name: "skill",
  def: {
    name: "skill",
    description:
      "Load a skill's full instructions by name. Call this first, then " +
      "follow the returned instructions. Optional args replace " +
      "$ARGUMENTS/$1..$N placeholders in the body (appended at the end " +
      "when the body has no placeholders).",
    parameters: zodToJsonSchema(SkillInput),
  },
  // Pure lookup over the bootstrap-time skills map: no filesystem, network,
  // or process access. Registered in READ_ONLY_ALLOWED so read-only
  // subagents can load skills too.
  accesses: {},
  inputSchema: SkillInput,
  normalize: (i) => `skill(${i.name})`,
  async execute(input, ctx): Promise<ToolOutput> {
    const spillId = `${ctx.sessionId}:${ctx.callId}`;
    const def = skills.get(input.name);
    if (def === undefined) {
      const names = [...skills.keys()].sort().slice(0, NOT_FOUND_LIST_CAP);
      const listing = names.length > 0 ? names.join(", ") : "(none)";
      return await toolOutput(
        `skill not found: ${input.name}; available skills: ${listing}`,
        spillId,
        { isError: true },
      );
    }
    const body = input.args !== undefined && input.args.trim() !== ""
      ? expandCommandTemplate(def.body, input.args)
      : def.body;
    return await toolOutput(
      `<skill name="${def.name}" dir="${def.dir}">\n` +
        `${body}\n` +
        `</skill>\n\n` +
        `Relative paths in the skill body resolve against the dir above.`,
      spillId,
    );
  },
});
