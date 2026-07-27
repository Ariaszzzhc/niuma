// Adapts MCP tools (from @modelcontextprotocol/sdk) to @niuma/tools' Tool
// interface so they flow through the standard pipeline: zod validation,
// permission Ask, scheduling, truncation.

import { z } from "zod";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import type { Accesses, JsonSchemaObject, Tool, ToolOutput } from "@niuma/tools";

/**
 * LLM tool APIs restrict names to [a-zA-Z0-9_-]. Encode every disallowed
 * code point — including the escape delimiter `_` itself — so distinct MCP
 * identifiers cannot collapse onto the same provider-facing name.
 */
export const sanitizeNameComponent = (s: string): string =>
  Array.from(
    s,
    (char) =>
      /[a-zA-Z0-9-]/.test(char)
        ? char
        : `_${char.codePointAt(0)!.toString(16)}_`,
  ).join("");

/** Collision-free tool name with a length-delimited server component. */
export const mcpToolName = (serverId: string, toolName: string): string => {
  const server = sanitizeNameComponent(serverId);
  return `mcp__${server.length}_${server}__${sanitizeNameComponent(toolName)}`;
};

// MCP inputs are validated server-side; locally a permissive passthrough is
// all the pipeline's zod step needs. The real schema goes to the LLM via
// `def.parameters` (the server's own JSON Schema, untranslated).
const PassthroughInput: z.ZodType<Record<string, unknown>> = z.looseObject({});
type PassthroughInput = z.infer<typeof PassthroughInput>;

export interface McpToolContext {
  readonly serverId: string;
  readonly client: Client;
  /** stdio servers spawn a subprocess, remote ones hit the network. */
  readonly accesses: Accesses;
}

export const mcpToolToNiumaTool = (
  mcpTool: McpTool,
  ctx: McpToolContext,
): Tool<PassthroughInput> => {
  const name = mcpToolName(ctx.serverId, mcpTool.name);
  return {
    name,
    def: {
      name,
      description: mcpTool.description ??
        `MCP tool ${mcpTool.name} from ${ctx.serverId}`,
      parameters: mcpTool.inputSchema as JsonSchemaObject,
    },
    accesses: ctx.accesses,
    inputSchema: PassthroughInput,
    // The policy chain matches on this string, so a rule like
    // `allow mcp__10_filesystem__*` addresses this server's tools.
    normalize: () => name,
    async execute(input, toolCtx): Promise<ToolOutput> {
      try {
        const result = await ctx.client.callTool(
          {
            name: mcpTool.name,
            arguments: input,
          },
          undefined,
          { signal: toolCtx.signal },
        );
        let content = renderContent(result.content ?? []);
        if (
          content.length === 0 && result.structuredContent !== undefined
        ) {
          content = JSON.stringify(result.structuredContent);
        }
        return {
          content: content.length > 0 ? content : "[no output]",
          ...(result.isError ? { isError: true } : {}),
        };
      } catch (e) {
        return {
          content: `mcp error: ${(e as Error).message}`,
          isError: true,
        };
      }
    },
  };
};

type ContentBlock = {
  readonly type?: string;
  readonly text?: string;
  readonly mimeType?: string;
};

/** Flatten MCP content blocks: text passes through, everything else is
 * serialised with a type/mimetype marker so the model knows what it got. */
const renderContent = (blocks: ReadonlyArray<unknown>): string => {
  const parts: string[] = [];
  for (const raw of blocks) {
    const b = raw as ContentBlock;
    if (b?.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else {
      const mime = typeof b?.mimeType === "string" ? ` (${b.mimeType})` : "";
      parts.push(`[${b?.type ?? "unknown"}${mime}] ${JSON.stringify(b)}`);
    }
  }
  return parts.join("\n");
};
