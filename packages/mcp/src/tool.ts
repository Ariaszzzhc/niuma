// Adapts MCP tools (from @modelcontextprotocol/sdk) to @niuma/tools' Tool
// interface so they flow through the standard pipeline: zod validation,
// permission Ask, scheduling, truncation.
//
// TODO(mcp): expose MCP resources and prompts as well — the sketch is one
// aggregate tool per server (`mcp__<server>__read_resource` /
// `mcp__<server>__get_prompt`) with the server's listing embedded in the
// tool description. Deferred from v1 to keep the surface minimal.

import { z } from "zod";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import type {
  Accesses,
  JsonSchemaObject,
  Tool,
  ToolOutput,
} from "@niuma/tools";

/** LLM tool APIs restrict names to [a-zA-Z0-9_-]; anything else folds to _. */
export const sanitizeNameComponent = (s: string): string =>
  s.replace(/[^a-zA-Z0-9_-]/g, "_");

/** Collision-free tool name: `mcp__<server>__<tool>`. */
export const mcpToolName = (serverId: string, toolName: string): string =>
  `mcp__${sanitizeNameComponent(serverId)}__${sanitizeNameComponent(toolName)}`;

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
    // `allow mcp__filesystem__*` addresses this server's tools.
    normalize: () => name,
    // NOTE: ctx.signal is not forwarded into callTool — the SDK types the
    // abort path through its compat result schema, and per-call cancellation
    // between pipeline steps already covers turn aborts in v1.
    async execute(input): Promise<ToolOutput> {
      try {
        const result = await ctx.client.callTool({
          name: mcpTool.name,
          arguments: input,
        });
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
