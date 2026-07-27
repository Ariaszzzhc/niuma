import type { Tool, ToolMode } from "./types.ts";
import { READ_ONLY_ALLOWED } from "./types.ts";
import { bashTool } from "./tools/bash.ts";
import { readTool } from "./tools/read.ts";
import { writeTool } from "./tools/write.ts";
import { editTool } from "./tools/edit.ts";
import { applyPatchTool } from "./tools/apply_patch.ts";
import { grepTool } from "./tools/grep.ts";
import { globTool } from "./tools/glob.ts";
import { updatePlanTool } from "./tools/update_plan.ts";
import { questionTool } from "./tools/question.ts";
import { spawnSubagentTool } from "./tools/spawn_subagent.ts";

/** Map of every built-in tool keyed by name, with optional custom additions. */
export class ToolRegistry {
  private readonly map = new Map<string, Tool>();

  constructor() {
    for (const t of builtins()) this.map.set(t.name, t);
  }

  /** Register or replace a tool. Returns `this` for chaining. */
  register(name: string, tool: Tool): this {
    this.map.set(name, tool);
    return this;
  }

  /** Look up a single tool. */
  get(name: string): Tool | undefined {
    return this.map.get(name);
  }

  /** Iterate all registered tools, optionally filtered by mode. */
  all(mode?: ToolMode): Tool[] {
    const all = [...this.map.values()];
    if (!mode) return all;
    if (mode === "read-only") {
      return all.filter((t) => READ_ONLY_ALLOWED.has(t.name));
    }
    return all;
  }
}

/** Default set of built-in tools, in stable order. */
export function builtins(): Tool[] {
  return [
    bashTool,
    readTool,
    writeTool,
    editTool,
    applyPatchTool,
    grepTool,
    globTool,
    updatePlanTool,
    questionTool,
    spawnSubagentTool,
  ];
}
