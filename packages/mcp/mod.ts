export const MCP_VERSION = "0.0.0";

export { connectMcpServers } from "./src/client.ts";
export type { McpServerHandle } from "./src/client.ts";
export {
  mcpToolName,
  mcpToolToNiumaTool,
  sanitizeNameComponent,
} from "./src/tool.ts";
export type { McpToolContext } from "./src/tool.ts";
