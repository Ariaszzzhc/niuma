import { z } from "zod";
import type { Tool, ToolOutput } from "../types.ts";
import { toolOutput } from "../truncate.ts";
import { zodToJsonSchema } from "../jsonSchema.ts";
import { resolvePath, PathError } from "../path.ts";
import { dirname } from "@std/path";

export const WriteInput = z.object({
  path: z.string().min(1).describe("Absolute or workspace-relative path."),
  content: z.string().describe("Full file content to write."),
});

export type WriteInput = z.infer<typeof WriteInput>;

export const writeTool: Tool<WriteInput> = {
  name: "write",
  def: {
    name: "write",
    description:
      "Write a file. Overwrites the file if it exists; creates intermediate directories as needed.",
    parameters: zodToJsonSchema(WriteInput),
  },
  accesses: { files: { write: [] } },
  inputSchema: WriteInput,
  normalize: (i) => i.path,
  paths: (i) => ({ write: [i.path] }),
  async execute(input, ctx): Promise<ToolOutput> {
    const callId = `write:${ctx.sessionId}:${input.path}`;
    let resolved;
    try {
      resolved = resolvePath(ctx.cwd, input.path);
    } catch (e) {
      if (e instanceof PathError) {
        return { content: `error: ${e.message}`, isError: true };
      }
      throw e;
    }
    try {
      // dirname operates on the literal string; the previous URL-based
      // computation percent-encoded spaces/non-ASCII and corrupted the path.
      await Deno.mkdir(dirname(resolved.abs), { recursive: true })
        .catch(() => {/* ignore — mkdir on existing dir is fine */});
      await Deno.writeTextFile(resolved.abs, input.content);
    } catch (e) {
      return await toolOutput(`error: ${(e as Error).message}`, callId, { isError: true });
    }
    const bytes = new TextEncoder().encode(input.content).byteLength;
    return await toolOutput(`wrote ${bytes} bytes to ${resolved.rel}`, callId);
  },
};