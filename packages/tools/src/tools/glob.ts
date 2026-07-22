import { z } from "zod";
import type { Tool, ToolOutput } from "../types.ts";
import { toolOutput } from "../truncate.ts";
import { zodToJsonSchema } from "../jsonSchema.ts";
import { resolvePath, PathError } from "../path.ts";
import { shouldSkipDir } from "../pathUtil.ts";
import { execCapture } from "../exec.ts";

export const GlobInput = z.object({
  pattern: z.string().min(1).describe("Glob pattern (rg --files compatible)."),
  path: z.string().optional().describe("Directory to start from; defaults to workspace root."),
  maxResults: z.number().int().positive().optional()
    .describe("Cap on results; default 200."),
});

export type GlobInput = z.infer<typeof GlobInput>;

const DEFAULT_CAP = 200;

export const globTool: Tool<GlobInput> = {
  name: "glob",
  def: {
    name: "glob",
    description:
      "List files matching a glob. Prefers `rg --files`; falls back to a JS walk that skips node_modules/.git/etc. Results sorted by mtime descending; capped.",
    parameters: zodToJsonSchema(GlobInput),
  },
  accesses: { files: { read: [] } },
  inputSchema: GlobInput,
  normalize: (i) => `${i.pattern} ${i.path ?? "."}`,
  paths: (i) => ({ read: [i.path ?? "."] }),
  async execute(input, ctx): Promise<ToolOutput> {
    const callId = `glob:${ctx.sessionId}:${input.pattern}`;
    const cap = input.maxResults ?? DEFAULT_CAP;
    let root: string;
    try {
      root = resolvePath(ctx.cwd, input.path ?? ".").abs;
    } catch (e) {
      if (e instanceof PathError) {
        return { content: `error: ${e.message}`, isError: true };
      }
      throw e;
    }

    const rg = await findRgPath();
    if (rg) {
      const cmd =
        `${rg} --files --sortr=modified -g ${escape(input.pattern)} -- ${escape(root)}`;
      const r = await execCapture(cmd, { cwd: ctx.cwd, timeoutMs: 60_000 });
      if (r.code === 0 || r.code === 1) {
        const all = r.stdout.split("\n").filter(Boolean);
        const capped = all.slice(0, cap);
        return await toolOutput(
          capped.join("\n") || "[no matches]",
          callId,
        );
      }
    }

    // JS fallback: collect by mtime.
    const re = compileGlob(input.pattern);
    const acc: { path: string; mtime: number }[] = [];
    const stack: string[] = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries: Deno.DirEntry[];
      try {
        entries = [...Deno.readDirSync(dir)];
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = `${dir}/${e.name}`;
        if (e.isDirectory) {
          if (shouldSkipDir(e.name)) continue;
          stack.push(full);
        } else if (e.isFile && re.test(full)) {
          try {
            const st = await Deno.stat(full);
            acc.push({ path: full, mtime: st.mtime?.getTime() ?? 0 });
          } catch {
            acc.push({ path: full, mtime: 0 });
          }
        }
      }
    }
    acc.sort((a, b) => b.mtime - a.mtime);
    return await toolOutput(
      acc.slice(0, cap).map((x) => x.path).join("\n") || "[no matches]",
      callId,
    );
  },
};

async function findRgPath(): Promise<string | null> {
  const explicit = Deno.env.get("NIUMA_RG");
  if (explicit) return explicit;
  const r = await execCapture("command -v rg", { timeoutMs: 2000 }).catch(() => null);
  if (r && r.code === 0 && r.stdout.trim()) return r.stdout.trim();
  return null;
}

function compileGlob(glob: string): RegExp {
  return new RegExp(
    "^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") +
      "$",
  );
}

function escape(s: string): string {
  if (s === "") return "''";
  return `'${s.replace(/'/g, `'\\''`)}'`;
}