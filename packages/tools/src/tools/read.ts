import { z } from "zod";
import type { Tool, ToolOutput } from "../types.ts";
import { toolOutput } from "../truncate.ts";
import { zodToJsonSchema } from "../json_schema.ts";
import { PathError, resolvePath } from "../path.ts";

// deno-lint-ignore no-slow-types
const ReadInput_ = z.object({
  path: z.string().min(1).describe("Absolute or workspace-relative path."),
  offset: z.number().int().nonnegative().optional()
    .describe(
      "1-indexed line number to start from; omit to read from the top.",
    ),
  limit: z.number().int().positive().optional()
    .describe("Max number of lines to return; default 2000."),
});

export type ReadInput = z.infer<typeof ReadInput_>;
export const ReadInput: z.ZodType<ReadInput> = ReadInput_;

const LINE_CAP = 2000;
const IMAGE_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
]);

export const readTool: Tool<ReadInput> = {
  name: "read",
  def: {
    name: "read",
    description:
      "Read a file. Text files are returned with a 2000-line cap and an offset continuation hint. Binary/image attachments are unsupported.",
    parameters: zodToJsonSchema(ReadInput),
  },
  accesses: { files: { read: [] } },
  inputSchema: ReadInput,
  normalize: (i) => i.path,
  paths: (i) => ({ read: [i.path] }),
  async execute(input, ctx): Promise<ToolOutput> {
    const spillId = `${ctx.sessionId}:${ctx.callId}`;
    let resolved;
    try {
      resolved = resolvePath(ctx.cwd, input.path);
    } catch (e) {
      if (e instanceof PathError) {
        return { content: `error: ${e.message}`, isError: true };
      }
      throw e;
    }
    let stat: Deno.FileInfo;
    try {
      stat = await Deno.stat(resolved.abs);
    } catch (e) {
      return await toolOutput(`error: ${(e as Error).message}`, spillId, {
        isError: true,
      });
    }
    if (!stat.isFile) {
      return {
        content: `error: not a regular file: ${input.path}`,
        isError: true,
      };
    }
    const ext = extOf(input.path);
    if (IMAGE_EXTS.has(ext)) {
      return {
        content: `[image attachment not supported] (${input.path})`,
      };
    }

    const text = await Deno.readTextFile(resolved.abs);
    const lines = text.split(/\r?\n/);
    const total = lines.length;
    const startLine = Math.max(0, (input.offset ?? 1) - 1);
    const limit = input.limit ?? LINE_CAP;
    const slice = lines.slice(startLine, startLine + limit);
    const numbered = slice.map((l, i) =>
      `${pad(startLine + i + 1, total)}\t${l}`
    );
    let body = numbered.join("\n");
    if (startLine + limit < total) {
      body += `\n\n[truncated at line ${startLine + limit}; ${
        total - (startLine + limit)
      } more lines — re-call with offset=${startLine + limit + 1}]`;
    }
    return await toolOutput(body, spillId);
  },
};

function extOf(p: string): string {
  const i = p.lastIndexOf(".");
  return i < 0 ? "" : p.slice(i).toLowerCase();
}

function pad(n: number, total: number): string {
  const w = String(total).length;
  return String(n).padStart(w, " ");
}
