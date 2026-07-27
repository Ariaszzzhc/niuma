import { z } from "zod";
import type { Tool, ToolOutput } from "../types.ts";
import { toolOutput } from "../truncate.ts";
import { zodToJsonSchema } from "../json_schema.ts";
import { PathError, resolvePath } from "../path.ts";
import { dirname } from "@std/path";

/**
 * codex-style patch grammar:
 *
 *   *** Begin Patch
 *   *** Add File: <path>
 *   +line1
 *   +line2
 *   *** Update File: <path>
 *   @@ optional class/function context
 *    unchanged context line
 *   -removed line
 *   +added line
 *   *** Delete File: <path>
 *   *** End Patch
 *
 * Robust to:
 *   - leading whitespace on `***` markers
 *   - `*** Add File` body lines without leading `+`
 *   - missing trailing newline on the patch
 */
// deno-lint-ignore no-slow-types
const ApplyPatchInput_ = z.object({
  patch: z.string().min(1).describe(
    "Patch body in the *** Begin Patch grammar.",
  ),
});

export type ApplyPatchInput = z.infer<typeof ApplyPatchInput_>;
export const ApplyPatchInput: z.ZodType<ApplyPatchInput> = ApplyPatchInput_;

type Hunk = {
  kind: "add" | "update" | "delete";
  path: string;
  // For update:
  contextLines?: string[];
  diffLines?: string[]; // lines starting with ' ' or '-' or '+'
};

export const applyPatchTool: Tool<ApplyPatchInput> = {
  name: "apply_patch",
  def: {
    name: "apply_patch",
    description:
      "Apply a codex-style patch. Use `*** Add File:` to create, `*** Update File:` for in-place edits, `*** Delete File:` to remove. Robust to minor whitespace sloppiness.",
    parameters: zodToJsonSchema(ApplyPatchInput),
  },
  accesses: { files: { read: [], write: [] } },
  inputSchema: ApplyPatchInput,
  normalize: (i) => firstPathOf(i.patch) ?? "(empty patch)",
  paths: (i) => {
    const hunks = (() => {
      try {
        return parsePatch(i.patch);
      } catch {
        return [] as Hunk[];
      }
    })();
    const read: string[] = [];
    const write: string[] = [];
    for (const h of hunks) {
      if (h.kind === "delete") read.push(h.path);
      else write.push(h.path);
      if (h.kind === "update") read.push(h.path);
    }
    return { read, write };
  },
  async execute(input, ctx): Promise<ToolOutput> {
    const spillId = `${ctx.sessionId}:${ctx.callId}:${shortHash(input.patch)}`;
    let hunks: Hunk[];
    try {
      hunks = parsePatch(input.patch);
    } catch (e) {
      return await toolOutput(`error: ${(e as Error).message}`, spillId, {
        isError: true,
      });
    }
    if (hunks.length === 0) {
      return await toolOutput(
        "error: patch contained no file operations",
        spillId,
        {
          isError: true,
        },
      );
    }

    const summary: string[] = [];
    for (const h of hunks) {
      let resolved;
      try {
        resolved = resolvePath(ctx.cwd, h.path);
      } catch (e) {
        if (e instanceof PathError) {
          return await toolOutput(`error: ${e.message}`, spillId, {
            isError: true,
          });
        }
        throw e;
      }
      try {
        if (h.kind === "add") {
          // dirname operates on the literal string; the previous URL-based
          // computation percent-encoded spaces/non-ASCII and corrupted the path.
          await Deno.mkdir(dirname(resolved.abs), { recursive: true }).catch(
            () => {},
          );
          await Deno.writeTextFile(
            resolved.abs,
            (h.diffLines ?? []).join("\n") + "\n",
          );
          summary.push(`+ ${resolved.rel}`);
        } else if (h.kind === "delete") {
          await Deno.remove(resolved.abs).catch(() => {});
          summary.push(`- ${resolved.rel}`);
        } else {
          const original = await Deno.readTextFile(resolved.abs);
          const eol = original.includes("\r\n") ? "\r\n" : "\n";
          const next = applyUpdate(original, h);
          await Deno.writeTextFile(resolved.abs, next.replace(/\n/g, eol));
          summary.push(`~ ${resolved.rel}`);
        }
      } catch (e) {
        return await toolOutput(
          `error applying to ${h.path}: ${(e as Error).message}`,
          spillId,
          { isError: true },
        );
      }
    }
    return await toolOutput(summary.join("\n"), spillId);
  },
};

// ---- Parser ----

export function parsePatch(patch: string): Hunk[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const hunks: Hunk[] = [];
  let i = 0;

  const skipBlank = () => {
    while (i < lines.length && lines[i].trim() === "") i++;
  };

  skipBlank();
  if (i >= lines.length || !lines[i].trim().startsWith("*** Begin Patch")) {
    throw new Error("patch must start with `*** Begin Patch`");
  }
  i++;

  while (i < lines.length) {
    skipBlank();
    if (i >= lines.length) break;
    const header = lines[i].trim();
    if (header === "*** End Patch" || header.startsWith("*** End Patch")) break;

    if (header.startsWith("*** Add File:")) {
      const path = header.slice("*** Add File:".length).trim();
      i++;
      const body: string[] = [];
      while (
        i < lines.length &&
        !lines[i].trim().startsWith("***") &&
        !lines[i].trim().startsWith("@@")
      ) {
        let line = lines[i];
        if (line.startsWith("+")) line = line.slice(1);
        body.push(line);
        i++;
      }
      hunks.push({ kind: "add", path, diffLines: body });
      continue;
    }

    if (header.startsWith("*** Delete File:")) {
      const path = header.slice("*** Delete File:".length).trim();
      hunks.push({ kind: "delete", path });
      i++;
      continue;
    }

    if (header.startsWith("*** Update File:")) {
      const path = header.slice("*** Update File:".length).trim();
      i++;
      const context: string[] = [];
      // Optional `@@ class/function` marker (consumed but informational).
      if (i < lines.length && lines[i].trim().startsWith("@@")) {
        i++;
      }
      const diff: string[] = [];
      while (
        i < lines.length &&
        !(lines[i].trim().startsWith("***")) &&
        !(lines[i].trim().startsWith("@@"))
      ) {
        diff.push(lines[i]);
        i++;
      }
      hunks.push({
        kind: "update",
        path,
        contextLines: context,
        diffLines: diff,
      });
      continue;
    }

    throw new Error(`unrecognised patch directive at line ${i + 1}: ${header}`);
  }

  return hunks;
}

// ---- Update applier ----
//
// Walks the original file line-by-line. When the leading context lines of
// the diff block match the file, applies the + / - ops anchored on the
// next context line. Falls back to fuzzy matching if no exact context
// anchors are present.

function applyUpdate(original: string, hunk: Hunk): string {
  const orig = original.replace(/\r\n/g, "\n").split("\n");
  const diff = (hunk.diffLines ?? []).map((l) => {
    if (l === "") return " ";
    return l[0] === " " || l[0] === "+" || l[0] === "-" ? l : " " + l;
  });

  // Strip trailing empty context lines (common in model output).
  while (diff.length > 0 && diff[diff.length - 1] === " ") diff.pop();

  // Try exact context match first.
  const exact = tryMatch(orig, diff);
  if (exact !== null) return exact;

  // Try fuzzy: align the first context line by content.
  const fuzzy = tryFuzzy(orig, diff);
  if (fuzzy !== null) return fuzzy;

  // Last resort: apply as full-file replacement.
  const allPlus = diff.every((l) => l.startsWith("+") || l === " ");
  if (allPlus) {
    return diff
      .filter((l) => l.startsWith("+") || l === " ")
      .map((l) => l.slice(1))
      .join("\n");
  }
  throw new Error("update hunk did not match any context");
}

function tryMatch(orig: string[], diff: string[]): string | null {
  // Find the first context line in the diff.
  let di = 0;
  while (di < diff.length && !diff[di].startsWith(" ")) di++;
  if (di === diff.length) return null;
  const anchor = diff[di].slice(1);
  const oi = orig.indexOf(anchor);
  if (oi < 0) return null;
  // Walk diff against orig from there.
  const out: string[] = [];
  let oiCur = 0;
  while (oiCur < oi) {
    out.push(orig[oiCur]);
    oiCur++;
  }
  let diCur = 0;
  while (diCur < diff.length) {
    const d = diff[diCur];
    if (d.startsWith(" ")) {
      if (orig[oiCur] !== d.slice(1)) return null;
      out.push(orig[oiCur]);
      oiCur++;
      diCur++;
    } else if (d.startsWith("-")) {
      if (orig[oiCur] !== d.slice(1)) return null;
      oiCur++;
      diCur++;
    } else if (d.startsWith("+")) {
      out.push(d.slice(1));
      diCur++;
    }
  }
  while (oiCur < orig.length) {
    out.push(orig[oiCur]);
    oiCur++;
  }
  return out.join("\n");
}

function tryFuzzy(orig: string[], diff: string[]): string | null {
  // Try every orig line that starts a diff context anchor.
  const anchors: string[] = [];
  for (const d of diff) {
    if (d.startsWith(" ")) anchors.push(d.slice(1));
  }
  for (let start = 0; start < orig.length; start++) {
    if (anchors.length > 0 && orig[start] !== anchors[0]) continue;
    const trial = tryMatch(orig.slice(start), diff);
    if (trial !== null) {
      return orig.slice(0, start).concat(trial.split("\n")).join("\n");
    }
  }
  return null;
}

function firstPathOf(patch: string): string | null {
  for (const line of patch.split("\n")) {
    const m = line.match(/^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+)$/);
    if (m) return m[1].trim();
  }
  return null;
}

function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).slice(0, 8);
}
