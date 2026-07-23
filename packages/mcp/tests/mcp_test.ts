import { assertEquals, assertStringIncludes } from "@std/assert";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  mcpToolName,
  mcpToolToNiumaTool,
  sanitizeNameComponent,
} from "../mod.ts";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolCtx } from "@niuma/tools";

const stubCtx: ToolCtx = {
  cwd: ".",
  sessionId: "test",
  signal: new AbortController().signal,
  ask: () => Promise.resolve({ decision: "once" }),
};

/** Spin up an in-memory MCP server + connected client for the test. */
const makeConnectedClient = async (
  setup: (server: McpServer) => void,
): Promise<{ server: McpServer; client: Client }> => {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  setup(server);
  const [clientTransport, serverTransport] = InMemoryTransport
    .createLinkedPair();
  const client = new Client({ name: "niuma-test", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { server, client };
};

Deno.test("sanitizeNameComponent / mcpToolName", () => {
  assertEquals(sanitizeNameComponent("my server!"), "my_server_");
  assertEquals(sanitizeNameComponent("plain-ok_1"), "plain-ok_1");
  assertEquals(mcpToolName("fs", "read file"), "mcp__fs__read_file");
});

Deno.test("mcpToolToNiumaTool: def, description fallback, parameters passthrough", async () => {
  const { server, client } = await makeConnectedClient((s) => {
    s.registerTool("echo", {
      description: "Echo the message.",
      inputSchema: { msg: z.string() },
    }, ({ msg }: { msg: string }) => ({
      content: [{ type: "text" as const, text: msg }],
    }));
    s.registerTool("undocumented", {}, () => ({
      content: [{ type: "text", text: "ok" }],
    }));
  });
  try {
    const { tools } = await client.listTools();
    const echo = mcpToolToNiumaTool(
      tools.find((t: McpTool) => t.name === "echo")!,
      {
        serverId: "test",
        client,
        accesses: {},
      },
    );
    assertEquals(echo.name, "mcp__test__echo");
    assertEquals(echo.def.name, "mcp__test__echo");
    assertEquals(echo.def.description, "Echo the message.");
    // The server's own JSON Schema reaches the LLM untranslated.
    const params = echo.def.parameters as {
      type: string;
      properties: Record<string, { type: string }>;
    };
    assertEquals(params.type, "object");
    assertEquals(params.properties.msg.type, "string");
    assertEquals(echo.normalize!({}), "mcp__test__echo");

    const undocumented = mcpToolToNiumaTool(
      tools.find((t: McpTool) => t.name === "undocumented")!,
      { serverId: "test", client, accesses: {} },
    );
    assertEquals(
      undocumented.def.description,
      "MCP tool undocumented from test",
    );
  } finally {
    await client.close();
    await server.close();
  }
});

Deno.test("mcpToolToNiumaTool: execute returns text content", async () => {
  const { server, client } = await makeConnectedClient((s) => {
    s.registerTool("echo", {
      inputSchema: { msg: z.string() },
    }, ({ msg }: { msg: string }) => ({
      content: [{ type: "text" as const, text: msg }],
    }));
  });
  try {
    const { tools } = await client.listTools();
    const echo = mcpToolToNiumaTool(tools[0]!, {
      serverId: "test",
      client,
      accesses: {},
    });
    const out = await echo.execute({ msg: "hello" }, stubCtx);
    assertEquals(out.content, "hello");
    assertEquals(out.isError, undefined);
  } finally {
    await client.close();
    await server.close();
  }
});

Deno.test("mcpToolToNiumaTool: isError passes through", async () => {
  const { server, client } = await makeConnectedClient((s) => {
    s.registerTool("fail", {}, () => ({
      content: [{ type: "text", text: "boom" }],
      isError: true,
    }));
  });
  try {
    const { tools } = await client.listTools();
    const fail = mcpToolToNiumaTool(tools[0]!, {
      serverId: "test",
      client,
      accesses: {},
    });
    const out = await fail.execute({}, stubCtx);
    assertEquals(out.content, "boom");
    assertEquals(out.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});

Deno.test("mcpToolToNiumaTool: transport failure wraps into an isError result", async () => {
  const { server, client } = await makeConnectedClient((s) => {
    s.registerTool("echo", {}, () => ({
      content: [{ type: "text", text: "ok" }],
    }));
  });
  const { tools } = await client.listTools();
  const echo = mcpToolToNiumaTool(tools[0]!, {
    serverId: "test",
    client,
    accesses: {},
  });
  // Closing the transport makes the subsequent callTool reject.
  await client.close();
  const out = await echo.execute({}, stubCtx);
  assertEquals(out.isError, true);
  assertStringIncludes(out.content, "mcp error:");
  await server.close();
});
