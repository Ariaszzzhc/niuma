import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  expandEnvVars,
  loadMergedMcpConfig,
  McpConfigError,
  mergeMcpConfigs,
  parseMcpConfig,
} from "../mod.ts";

Deno.test("parseMcpConfig: empty document yields {}", () => {
  assertEquals(parseMcpConfig("{}"), {});
  assertEquals(parseMcpConfig(`{"mcpServers": {}}`), {});
});

Deno.test("parseMcpConfig: stdio server, type defaults to stdio", () => {
  const c = parseMcpConfig(`{
    "mcpServers": {
      "filesystem": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
        "env": { "KEY": "value" }
      }
    }
  }`);
  const s = c.filesystem!;
  assertEquals(s.id, "filesystem");
  assertEquals(s.type, "stdio");
  assertEquals(s.command, "npx");
  assertEquals(s.args, ["-y", "@modelcontextprotocol/server-filesystem", "."]);
  assertEquals(s.env, { KEY: "value" });
  assertEquals(s.enabled, undefined);
});

Deno.test("parseMcpConfig: http and sse servers", () => {
  const c = parseMcpConfig(`{
    "mcpServers": {
      "search": {
        "type": "http",
        "url": "https://example.com/mcp",
        "headers": { "Authorization": "Bearer tok" }
      },
      "legacy": { "type": "sse", "url": "https://example.com/sse" }
    }
  }`);
  assertEquals(c.search!.type, "http");
  assertEquals(c.search!.url, "https://example.com/mcp");
  assertEquals(c.search!.headers, { Authorization: "Bearer tok" });
  assertEquals(c.legacy!.type, "sse");
});

Deno.test("parseMcpConfig: enabled flag and unknown fields tolerated", () => {
  const c = parseMcpConfig(`{
    "mcpServers": {
      "off": { "command": "x", "enabled": false, "futureField": 1 }
    }
  }`);
  assertEquals(c.off!.enabled, false);
});

Deno.test("parseMcpConfig: transport field mismatches are rejected", () => {
  assertThrows(
    () => parseMcpConfig(`{"mcpServers": {"a": {"args": []}}}`),
    McpConfigError,
    'stdio server but has no "command"',
  );
  assertThrows(
    () =>
      parseMcpConfig(
        `{"mcpServers": {"a": {"command": "x", "url": "https://y"}}}`,
      ),
    McpConfigError,
    '"url" only applies to http/sse',
  );
  assertThrows(
    () => parseMcpConfig(`{"mcpServers": {"a": {"type": "http"}}}`),
    McpConfigError,
    'http server but has no "url"',
  );
  assertThrows(
    () =>
      parseMcpConfig(
        `{"mcpServers": {"a": {"type": "sse", "command": "x", "url": "https://y"}}}`,
      ),
    McpConfigError,
    '"command" only applies to stdio',
  );
});

Deno.test("parseMcpConfig: wrong field types are rejected", () => {
  assertThrows(
    () => parseMcpConfig(`{"mcpServers": {"a": {"type": "grpc"}}}`),
    McpConfigError,
    "stdio|http|sse",
  );
  assertThrows(
    () =>
      parseMcpConfig(`{"mcpServers": {"a": {"command": "x", "args": "y"}}}`),
    McpConfigError,
    "array of strings",
  );
  assertThrows(
    () =>
      parseMcpConfig(
        `{"mcpServers": {"a": {"command": "x", "enabled": "no"}}}`,
      ),
    McpConfigError,
    "a boolean",
  );
  assertThrows(
    () => parseMcpConfig(`{"mcpServers": []}`),
    McpConfigError,
    "a table",
  );
  assertThrows(() => parseMcpConfig(`not json`), McpConfigError, "parse");
});

Deno.test("expandEnvVars: ${VAR}, ${VAR:-default}, undefined → empty", () => {
  Deno.env.set("NIUMA_TEST_MCP_VAR", "hello");
  try {
    assertEquals(expandEnvVars("${NIUMA_TEST_MCP_VAR}"), "hello");
    assertEquals(
      expandEnvVars("p-${NIUMA_TEST_MCP_VAR}-s"),
      "p-hello-s",
    );
    assertEquals(expandEnvVars("${NIUMA_TEST_MCP_MISSING:-fb}"), "fb");
    assertEquals(expandEnvVars("${NIUMA_TEST_MCP_MISSING}"), "");
    // A set variable wins over its default.
    assertEquals(expandEnvVars("${NIUMA_TEST_MCP_VAR:-fb}"), "hello");
  } finally {
    Deno.env.delete("NIUMA_TEST_MCP_VAR");
  }
});

Deno.test("parseMcpConfig: env references expand at parse time", () => {
  Deno.env.set("NIUMA_TEST_MCP_TOK", "secret");
  try {
    const c = parseMcpConfig(`{
      "mcpServers": {
        "a": {
          "command": "run",
          "args": ["--tok", "\${NIUMA_TEST_MCP_TOK}"],
          "env": { "T": "\${NIUMA_TEST_MCP_TOK}" }
        },
        "b": {
          "type": "http",
          "url": "https://\${NIUMA_TEST_MCP_TOK}.example.com/mcp",
          "headers": { "Authorization": "Bearer \${NIUMA_TEST_MCP_TOK}" }
        }
      }
    }`);
    assertEquals(c.a!.args, ["--tok", "secret"]);
    assertEquals(c.a!.env, { T: "secret" });
    assertEquals(c.b!.url, "https://secret.example.com/mcp");
    assertEquals(c.b!.headers, { Authorization: "Bearer secret" });
  } finally {
    Deno.env.delete("NIUMA_TEST_MCP_TOK");
  }
});

Deno.test("mergeMcpConfigs: later levels replace per server id", () => {
  const low = parseMcpConfig(`{
    "mcpServers": {
      "a": { "command": "low-a" },
      "b": { "command": "low-b" }
    }
  }`);
  const high = parseMcpConfig(`{
    "mcpServers": { "a": { "type": "http", "url": "https://high" } }
  }`);
  const merged = mergeMcpConfigs(low, high);
  assertEquals(merged.a!.type, "http");
  assertEquals(merged.a!.command, undefined);
  assertEquals(merged.b!.command, "low-b");
});

Deno.test("loadMergedMcpConfig: priority .mcp.json > project .niuma/mcp.json > global mcp.json", async () => {
  const root = await Deno.makeTempDir();
  try {
    const globalDir = join(root, "global");
    await Deno.mkdir(globalDir);
    await Deno.writeTextFile(
      join(globalDir, "mcp.json"),
      `{"mcpServers": {
        "shared": { "command": "global-shared" },
        "global-only": { "command": "global-only" }
      }}`,
    );
    const repo = join(root, "repo");
    const pkg = join(repo, "packages", "x");
    await Deno.mkdir(join(repo, ".niuma"), { recursive: true });
    await Deno.mkdir(pkg, { recursive: true });
    await Deno.writeTextFile(
      join(repo, ".niuma", "mcp.json"),
      `{"mcpServers": {
        "shared": { "command": "repo-shared" },
        "off-here": { "command": "global-would-add" }
      }}`,
    );
    // The workspace's own .mcp.json outranks every .niuma/mcp.json.
    await Deno.writeTextFile(
      join(pkg, ".mcp.json"),
      `{"mcpServers": {
        "shared": { "command": "ws-shared" },
        "off-here": { "command": "unused", "enabled": false }
      }}`,
    );
    const c = await loadMergedMcpConfig({
      globalConfigDir: globalDir,
      workspace: pkg,
    });
    assertEquals(c.shared!.command, "ws-shared");
    assertEquals(c["global-only"]!.command, "global-only");
    assertEquals(c["off-here"]!.enabled, false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("loadMergedMcpConfig: nearer project dir wins over farther one", async () => {
  const root = await Deno.makeTempDir();
  try {
    const repo = join(root, "repo");
    const pkg = join(repo, "pkg");
    await Deno.mkdir(join(repo, ".niuma"), { recursive: true });
    await Deno.mkdir(join(pkg, ".niuma"), { recursive: true });
    await Deno.writeTextFile(
      join(repo, ".niuma", "mcp.json"),
      `{"mcpServers": {"a": {"command": "repo"}}}`,
    );
    await Deno.writeTextFile(
      join(pkg, ".niuma", "mcp.json"),
      `{"mcpServers": {"a": {"command": "pkg"}}}`,
    );
    const c = await loadMergedMcpConfig({
      globalConfigDir: join(root, "no-global"),
      workspace: pkg,
    });
    assertEquals(c.a!.command, "pkg");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("loadMergedMcpConfig: no files anywhere yields {}", async () => {
  const root = await Deno.makeTempDir();
  try {
    const ws = join(root, "ws");
    await Deno.mkdir(ws);
    const c = await loadMergedMcpConfig({
      globalConfigDir: join(root, "global"),
      workspace: ws,
    });
    assertEquals(c, {});
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
