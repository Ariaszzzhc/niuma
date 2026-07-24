import { z } from "zod";
import type { Tool, ToolOutput } from "../types.ts";
import { toolOutput } from "../truncate.ts";
import { zodToJsonSchema } from "../json_schema.ts";
import { PathError, resolvePath } from "../path.ts";

// deno-lint-ignore no-slow-types
const EditOp = z.object({
  oldText: z.string().describe("Exact substring to replace."),
  newText: z.string().describe("Replacement text."),
  replaceAll: z.boolean().optional()
    .describe("Replace every occurrence; default false (uniqueness required)."),
});

// deno-lint-ignore no-slow-types
const EditInput_ = z.object({
  path: z.string().min(1).describe("Absolute or workspace-relative path."),
  edits: z.array(EditOp).min(1).describe("Edits to apply in order."),
});

export type EditInput = z.infer<typeof EditInput_>;
export const EditInput: z.ZodType<EditInput> = EditInput_;

export const editTool: Tool<EditInput> = {
  name: "edit",
  def: {
    name: "edit",
    description:
      "Edit a file by replacing exact substrings. By default each `oldText` must be unique; pass `replaceAll` for global replace. Line endings are preserved.",
    parameters: zodToJsonSchema(EditInput),
  },
  accesses: { files: { read: [], write: [] } },
  inputSchema: EditInput,
  normalize: (i) => i.path,
  paths: (i) => ({ read: [i.path], write: [i.path] }),
  async execute(input, ctx): Promise<ToolOutput> {
    const callId = `edit:${ctx.sessionId}:${input.path}`;
    let resolved;
    try {
      resolved = resolvePath(ctx.cwd, input.path);
    } catch (e) {
      if (e instanceof PathError) {
        return { content: `error: ${e.message}`, isError: true };
      }
      throw e;
    }
    let original: string;
    try {
      original = await Deno.readTextFile(resolved.abs);
    } catch (e) {
      return await toolOutput(`error: ${(e as Error).message}`, callId, {
        isError: true,
      });
    }

    const eol = detectEol(original);
    const normalised = original.split(/\r\n|\n|\r/).join("\n");
    let working = normalised;
    const log: string[] = [];

    for (let i = 0; i < input.edits.length; i++) {
      const e = input.edits[i];
      const occurrences = countOccurrences(working, e.oldText);
      if (occurrences === 0) {
        return await toolOutput(
          `error: edit #${i + 1} did not match (no occurrence of oldText)`,
          callId,
          { isError: true },
        );
      }
      if (!e.replaceAll && occurrences > 1) {
        return await toolOutput(
          `error: edit #${
            i + 1
          } matched ${occurrences} times — pass replaceAll:true or provide more context`,
          callId,
          { isError: true },
        );
      }
      if (e.replaceAll) {
        working = working.split(e.oldText).join(e.newText);
        log.push(
          `edit #${i + 1}: ${occurrences} replacement${
            occurrences === 1 ? "" : "s"
          }`,
        );
      } else {
        // Replace exactly the first (and only) occurrence.
        const idx = working.indexOf(e.oldText);
        working = working.slice(0, idx) + e.newText +
          working.slice(idx + e.oldText.length);
        log.push(`edit #${i + 1}: 1 replacement`);
      }
    }

    const restored = eol === "\r\n" ? working.replace(/\n/g, "\r\n") : working;
    try {
      await Deno.writeTextFile(resolved.abs, restored);
    } catch (e) {
      return await toolOutput(`error: ${(e as Error).message}`, callId, {
        isError: true,
      });
    }
    return await toolOutput(log.join("\n") + `\nwrote ${resolved.rel}`, callId);
  },
};

/** Detect whether the file uses CRLF (return "\r\n") or LF ("\n"). */
function detectEol(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** Count non-overlapping occurrences of `needle` in `s`. Empty needle → 0. */
function countOccurrences(s: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let i = 0;
  while (true) {
    const j = s.indexOf(needle, i);
    if (j < 0) break;
    count++;
    i = j + needle.length;
  }
  return count;
}
