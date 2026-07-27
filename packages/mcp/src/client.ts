// Connects the MCP servers from the merged mcp.json config and adapts each
// server's tools for the niuma ToolRegistry. A server that fails to connect
// is skipped with a warning — one bad entry must not take down startup.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { getLogger } from "@logtape/logtape";
import { type McpConfig, type McpServerConfig, VERSION } from "@niuma/config";
import type { Accesses, Tool } from "@niuma/tools";
import { mcpToolToNiumaTool } from "./tool.ts";

const logger = getLogger(["niuma", "mcp"]);

export interface McpServerHandle {
  readonly id: string;
  /** The server's tools, adapted to the niuma Tool interface. */
  readonly tools: ReadonlyArray<Tool>;
  /** Close the transport (kills the stdio subprocess / drops the HTTP session). */
  readonly close: () => Promise<void>;
}

/** Connect every enabled server, best-effort. Returns the ones that came up. */
export const connectMcpServers = async (
  config: McpConfig,
): Promise<McpServerHandle[]> => {
  const handles: McpServerHandle[] = [];
  for (const server of Object.values(config)) {
    if (server.enabled === false) continue;
    try {
      handles.push(await connectServer(server));
    } catch (e) {
      logger.warn("mcp: failed to connect to server {id}: {error}", {
        id: server.id,
        error: (e as Error).message,
      });
    }
  }
  return handles;
};

const connectServer = async (
  server: McpServerConfig,
): Promise<McpServerHandle> => {
  const client = new Client({ name: "niuma", version: VERSION });
  const { transport, accesses } = makeTransport(server);
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const seen = new Set<string>();
    const adapted: Tool[] = [];
    for (const t of tools) {
      const tool = mcpToolToNiumaTool(t, {
        serverId: server.id,
        client,
        accesses,
      });
      if (seen.has(tool.name)) {
        logger.warn(
          "mcp: duplicate tool name {name} from server {id}; skipping",
          { name: tool.name, id: server.id },
        );
        continue;
      }
      seen.add(tool.name);
      adapted.push(tool);
    }
    logger.info("mcp: server {id} connected, {count} tool(s)", {
      id: server.id,
      count: adapted.length,
    });
    return { id: server.id, tools: adapted, close: () => client.close() };
  } catch (error) {
    try {
      await client.close();
    } catch {
      // Preserve the connection/listing failure that made this server unusable.
    }
    throw error;
  }
};

const makeTransport = (
  server: McpServerConfig,
): { transport: Transport; accesses: Accesses } => {
  const headers = server.headers ? { ...server.headers } : undefined;
  switch (server.type) {
    case "stdio":
      return {
        transport: new StdioClientTransport({
          // Validated at parse time: stdio servers always carry a command.
          command: server.command!,
          args: [...(server.args ?? [])],
          // The SDK replaces the child env wholesale when one is given, so
          // seed it with the default (PATH, HOME, ...) before applying the
          // user's entries — matching how Claude Code merges env.
          env: { ...getDefaultEnvironment(), ...(server.env ?? {}) },
        }),
        accesses: { process: true },
      };
    case "http":
      return {
        transport: new StreamableHTTPClientTransport(
          // Validated at parse time: http/sse servers always carry a url.
          new URL(server.url!),
          ...(headers ? [{ requestInit: { headers } }] : []),
        ),
        accesses: { network: true },
      };
    case "sse":
      return {
        transport: new SSEClientTransport(
          new URL(server.url!),
          ...(headers ? [{ requestInit: { headers } }] : []),
        ),
        accesses: { network: true },
      };
  }
};
