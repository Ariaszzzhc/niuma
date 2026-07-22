import type { Tool, ToolDefLike, ToolMode } from "./types.ts";
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

/**
 * Map of every built-in tool keyed by name. Custom tools can be added via
 * `register(name, tool)`; the registry is then queried by name through
 * `resolve(names)`.
 */
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

  /** Remove a tool (no-op when absent). */
  unregister(name: string): boolean {
    return this.map.delete(name);
  }

  /** Look up a single tool. */
  get(name: string): Tool | undefined {
    return this.map.get(name);
  }

  /**
   * Resolve a list of tool names into the corresponding `Tool` records.
   * Unknown names are silently skipped — the pipeline surfaces a friendly
   * `unknown tool` error when the model asks for them in a turn.
   */
  resolve(names: readonly string[]): Tool[] {
    const out: Tool[] = [];
    for (const n of names) {
      const t = this.map.get(n);
      if (t) out.push(t);
    }
    return out;
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

  /** Number of registered tools. */
  size(): number {
    return this.map.size;
  }

  /**
   * Build a `ToolDef[]`-shaped array for the LLM request. Pass a `mode` to
   * restrict to the read-only allowlist (used for subagents); pass an
   * explicit `names` list for finer-grained selection. The legacy
   * `toToolDefs(["bash"])` positional form is still accepted.
   */
  toToolDefs(
    optsOrNames?:
      | { mode?: ToolMode; names?: readonly string[] }
      | readonly string[],
  ): ToolDefLike[] {
    let mode: ToolMode | undefined;
    let names: readonly string[] | undefined;
    if (isReadOnlyStringArray(optsOrNames)) {
      names = optsOrNames;
    } else if (optsOrNames) {
      mode = optsOrNames.mode;
      names = optsOrNames.names;
    }
    const tools = names ? this.resolve(names) : this.all(mode);
    return tools.map((t) => t.def);
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

/**
 * User-defined type guard for the legacy positional form of `toToolDefs`.
 * `Array.isArray` narrows to `any[]`, which doesn't satisfy `readonly string[]`
 * under TS's readonly/mutable distinctions, so we use an explicit guard.
 */
function isReadOnlyStringArray(
  v: unknown,
): v is readonly string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Build a `Map<string, Tool>` from an iterable (used by the pipeline). */
export function toToolMap(tools: Iterable<Tool>): Map<string, Tool> {
  const m = new Map<string, Tool>();
  for (const t of tools) m.set(t.name, t);
  return m;
}
