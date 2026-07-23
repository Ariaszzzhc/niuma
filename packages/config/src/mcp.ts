// MCP server configuration, in Claude Code's `.mcp.json` format:
//
//   {
//     "mcpServers": {
//       "filesystem": {
//         "type": "stdio",                      // default; may be omitted
//         "command": "npx",
//         "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
//         "env": { "API_KEY": "${MY_API_KEY}" }
//       },
//       "remote-search": {
//         "type": "http",                        // or "sse"
//         "url": "https://example.com/mcp",
//         "headers": { "Authorization": "Bearer ${SEARCH_TOKEN}" }
//       }
//     }
//   }
//
// Three levels are merged, lowest priority first (3 > 2 > 1):
//
//   1. <global config dir>/mcp.json   (~/.niuma/mcp.json)
//   2. <dir>/.niuma/mcp.json for every dir on the project-config path (the
//      dirs projectConfigDirs finds walking from the workspace up to $HOME;
//      closer dirs win, all of them beat level 1)
//   3. <workspace>/.mcp.json          (Claude Code's project location)
//
// Merging is per server id: a higher-priority file's entry REPLACES the
// lower-priority one wholesale. Combined with the `enabled` extension
// (below), a project can switch off a globally-defined server.
//
// `${VAR}` / `${VAR:-default}` references in command/args/env/url/headers
// are expanded at parse time, matching Claude Code's behaviour.
//
// `enabled` (default true) is a niuma extension — Claude Code has no such
// field; everything else follows its format. Unknown fields are tolerated,
// declared fields with the wrong type are rejected (same policy as
// config.toml).

import { join } from "@std/path";
import { PROJECT_DIR_BASENAME, projectConfigDirs } from "./config.ts";

const envGet = (name: string): string | undefined => {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
};

export const MCP_CONFIG_BASENAME = "mcp.json";
export const WORKSPACE_MCP_CONFIG_BASENAME = ".mcp.json";

export interface McpServerConfig {
  readonly id: string;
  /** Transport. "stdio" spawns a local subprocess; "http"/"sse" connect to
   * a remote endpoint. Defaults to "stdio" when omitted (Claude Code). */
  readonly type: "stdio" | "http" | "sse";
  /** stdio: executable to spawn. */
  readonly command?: string;
  /** stdio: argv for the subprocess. */
  readonly args?: readonly string[];
  /** stdio: extra environment for the subprocess. */
  readonly env?: Readonly<Record<string, string>>;
  /** http/sse: remote endpoint. */
  readonly url?: string;
  /** http/sse: extra request headers. */
  readonly headers?: Readonly<Record<string, string>>;
  /** niuma extension: false skips the server at connect time. Default true. */
  readonly enabled?: boolean;
}

/** Effective MCP configuration, keyed by server id. */
export type McpConfig = Readonly<Record<string, McpServerConfig>>;

export class McpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpConfigError";
  }
}

/** Expand Claude Code-style `${VAR}` / `${VAR:-default}` references.
 * Undefined variables without a default expand to the empty string. */
export const expandEnvVars = (value: string): string =>
  value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_whole, name: string, fallback?: string) =>
      envGet(name) ?? fallback ?? "",
  );

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const typeErr = (path: string, expected: string, got: unknown): McpConfigError =>
  new McpConfigError(
    `mcp config: ${path} must be ${expected}, got ${
      Array.isArray(got) ? "array" : typeof got
    }`,
  );

const optString = (
  obj: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined => {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw typeErr(`${path}.${key}`, "a string", v);
  return expandEnvVars(v);
};

const optStringArray = (
  obj: Record<string, unknown>,
  key: string,
  path: string,
): readonly string[] | undefined => {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw typeErr(`${path}.${key}`, "an array of strings", v);
  }
  return (v as string[]).map(expandEnvVars);
};

const optStringRecord = (
  obj: Record<string, unknown>,
  key: string,
  path: string,
): Readonly<Record<string, string>> | undefined => {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (!isRecord(v)) throw typeErr(`${path}.${key}`, "a table", v);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== "string") {
      throw typeErr(`${path}.${key}.${k}`, "a string", val);
    }
    out[k] = expandEnvVars(val);
  }
  return out;
};

const optBoolean = (
  obj: Record<string, unknown>,
  key: string,
  path: string,
): boolean | undefined => {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw typeErr(`${path}.${key}`, "a boolean", v);
  return v;
};

const SERVER_TYPES = ["stdio", "http", "sse"] as const;

const parseServer = (id: string, raw: unknown): McpServerConfig => {
  const path = `mcpServers.${id}`;
  if (!isRecord(raw)) throw typeErr(path, "a table", raw);

  const typeRaw = raw.type;
  if (typeRaw !== undefined && typeof typeRaw !== "string") {
    throw typeErr(`${path}.type`, "a string", typeRaw);
  }
  const type = (typeRaw ?? "stdio") as McpServerConfig["type"];
  if (!(SERVER_TYPES as readonly string[]).includes(type)) {
    throw new McpConfigError(
      `mcp config: ${path}.type must be one of ${SERVER_TYPES.join("|")}, got "${
        String(typeRaw)
      }"`,
    );
  }

  const command = optString(raw, "command", path);
  const url = optString(raw, "url", path);
  if (type === "stdio") {
    if (!command) {
      throw new McpConfigError(
        `mcp config: ${path} is a stdio server but has no "command"`,
      );
    }
    if (url !== undefined) {
      throw new McpConfigError(
        `mcp config: ${path} is a stdio server; "url" only applies to http/sse`,
      );
    }
  } else {
    if (!url) {
      throw new McpConfigError(
        `mcp config: ${path} is a ${type} server but has no "url"`,
      );
    }
    if (command !== undefined) {
      throw new McpConfigError(
        `mcp config: ${path} is a ${type} server; "command" only applies to stdio`,
      );
    }
  }

  const args = optStringArray(raw, "args", path);
  const env = optStringRecord(raw, "env", path);
  const headers = optStringRecord(raw, "headers", path);
  const enabled = optBoolean(raw, "enabled", path);

  return {
    id,
    type,
    ...(command !== undefined ? { command } : {}),
    ...(args !== undefined ? { args } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
  };
};

/** Parse already-read mcp.json text. Throws McpConfigError on bad
 * syntax/types. An empty document (no `mcpServers`) yields {}. */
export const parseMcpConfig = (
  text: string,
  source = "mcp.json",
): McpConfig => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new McpConfigError(
      `mcp config: failed to parse ${source}: ${(e as Error).message}`,
    );
  }
  if (!isRecord(raw)) throw typeErr("(root)", "a table", raw);
  const servers = raw.mcpServers ?? {};
  if (!isRecord(servers)) throw typeErr("mcpServers", "a table", servers);
  const out: Record<string, McpServerConfig> = {};
  for (const [id, s] of Object.entries(servers)) {
    out[id] = parseServer(id, s);
  }
  return out;
};

/** Load and parse an mcp.json file; a missing file yields {}. */
export const loadMcpConfigFile = async (path: string): Promise<McpConfig> => {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return {};
    throw new McpConfigError(
      `mcp config: failed to read ${path}: ${(e as Error).message}`,
    );
  }
  return parseMcpConfig(text, path);
};

/** Merge levels from lowest to highest priority: for each server id, the
 * later level's entry replaces the earlier one wholesale. */
export const mergeMcpConfigs = (...levels: McpConfig[]): McpConfig =>
  Object.assign({}, ...levels);

export interface LoadMergedMcpOptions {
  /** Global niuma config dir (niumaPaths().config); level 1 lives inside it. */
  readonly globalConfigDir: string;
  /** Session workspace; anchors level 2 discovery and level 3's .mcp.json. */
  readonly workspace: string;
}

/**
 * Load the effective MCP config: global mcp.json, then every project-dir
 * .niuma/mcp.json (shallow → deep, so the closest directory wins), then the
 * workspace's own .mcp.json on top. Priority: 3 > 2 > 1.
 */
export const loadMergedMcpConfig = async (
  opts: LoadMergedMcpOptions,
): Promise<McpConfig> => {
  const levels: McpConfig[] = [
    await loadMcpConfigFile(join(opts.globalConfigDir, MCP_CONFIG_BASENAME)),
  ];
  // projectConfigDirs is leaf-first; merge shallow-first so the closest
  // directory wins (same convention as .niuma/config.toml).
  const projectFiles = projectConfigDirs(opts.workspace)
    .map((dir) => join(dir, PROJECT_DIR_BASENAME, MCP_CONFIG_BASENAME))
    .reverse();
  for (const file of projectFiles) {
    levels.push(await loadMcpConfigFile(file));
  }
  levels.push(
    await loadMcpConfigFile(
      join(opts.workspace, WORKSPACE_MCP_CONFIG_BASENAME),
    ),
  );
  return mergeMcpConfigs(...levels);
};
