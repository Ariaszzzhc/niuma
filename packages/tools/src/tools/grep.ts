import { z } from "zod";
import type { Tool, ToolOutput } from "../types.ts";
import { toolOutput } from "../truncate.ts";
import { zodToJsonSchema } from "../json_schema.ts";
import { PathError, resolvePath } from "../path.ts";
import { shouldSkipDir } from "../path_util.ts";
import { execCapture } from "../exec.ts";

// deno-lint-ignore no-slow-types
const GrepInput_ = z.object({
  pattern: z.string().min(1).describe(
    "Regex pattern (rg flavor when shelling out).",
  ),
  path: z.string().optional()
    .describe("File or directory to search; defaults to workspace root."),
  glob: z.string().optional().describe("Filter to files matching this glob."),
  maxResults: z.number().int().positive().optional()
    .describe("Cap on results; default 200."),
  caseInsensitive: z.boolean().optional(),
  lineNumbers: z.boolean().optional().describe(
    "Show 1-indexed line numbers; default true.",
  ),
});

export type GrepInput = z.infer<typeof GrepInput_>;
export const GrepInput: z.ZodType<GrepInput> = GrepInput_;

const MAX_RESULTS_DEFAULT = 200;

export const grepTool: Tool<GrepInput> = {
  name: "grep",
  def: {
    name: "grep",
    description:
      "Search file contents for a regex. Prefers `rg` when available; falls back to a JS regex walk that skips node_modules/.git/dist/build/etc.",
    parameters: zodToJsonSchema(GrepInput),
  },
  accesses: { files: { read: [] } },
  inputSchema: GrepInput,
  normalize: (i) => `${i.pattern} ${i.path ?? "."}`,
  paths: (i) => ({ read: [i.path ?? "."] }),
  async execute(input, ctx): Promise<ToolOutput> {
    const spillId = `${ctx.sessionId}:${ctx.callId}`;
    const max = input.maxResults ?? MAX_RESULTS_DEFAULT;
    const ln = input.lineNumbers !== false;
    const ci = input.caseInsensitive ? "-i" : "";

    // 1. Try rg first.
    const rgPath = await findRgPath();
    if (rgPath) {
      const cmd = [
        rgPath,
        "--no-heading",
        "--color=never",
        ln ? "--line-number" : "--no-line-number",
        ...(ci ? [ci] : []),
        ...(input.glob ? ["-g", input.glob] : []),
        "--",
        input.pattern,
        input.path ?? ctx.cwd,
      ];
      const r = await execCapture(cmd, {
        cwd: ctx.cwd,
        timeoutMs: 60_000,
        signal: ctx.signal,
      });
      if (r.code === 0 || r.code === 1) {
        const output = takeResultLines(r.stdout, max);
        return await toolOutput(output || "[no matches]", spillId);
      }
      // rg failed for some other reason — fall through to JS walk.
    }

    // 2. JS walk fallback.
    let root: string;
    try {
      const resolved = resolvePath(ctx.cwd, input.path ?? ".");
      root = resolved.abs;
    } catch (e) {
      if (e instanceof PathError) {
        return { content: `error: ${e.message}`, isError: true };
      }
      throw e;
    }
    const regex = compileRegex(input.pattern, !!input.caseInsensitive);
    const out: string[] = [];
    const limit = input.maxResults ?? MAX_RESULTS_DEFAULT;

    await walk(root, async (file) => {
      if (out.length >= limit) return false;
      if (input.glob && !matchSimpleGlob(input.glob, file)) return true;
      try {
        const text = await Deno.readTextFile(file);
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            out.push(
              ln ? `${file}:${i + 1}:${lines[i]}` : `${file}:${lines[i]}`,
            );
            if (out.length >= limit) break;
          }
        }
      } catch {
        // binary / unreadable — skip
      }
      return true;
    });

    return await toolOutput(
      out.length ? out.join("\n") : "[no matches]",
      spillId,
    );
  },
};

async function findRgPath(): Promise<string | null> {
  // Honour explicit override; otherwise check `which rg`.
  const explicit = Deno.env.get("NIUMA_RG");
  if (explicit) return explicit;
  const r = await execCapture("command -v rg", { timeoutMs: 2000 }).catch(() =>
    null
  );
  if (r && r.code === 0 && r.stdout.trim()) return r.stdout.trim();
  return null;
}

function compileRegex(pattern: string, ci: boolean): RegExp {
  try {
    return new RegExp(pattern, ci ? "i" : "");
  } catch {
    // Treat as literal.
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped, ci ? "i" : "");
  }
}

async function walk(
  root: string,
  visit: (file: string) => Promise<boolean>,
): Promise<void> {
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
      } else if (e.isFile) {
        const keep = await visit(full);
        if (!keep) return;
      }
    }
  }
}

function matchSimpleGlob(glob: string, path: string): boolean {
  const re = "^" +
    glob.replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".") +
    "$";
  return new RegExp(re).test(path);
}

function takeResultLines(output: string, limit: number): string {
  const lines = output.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(0, limit).join("\n");
}
