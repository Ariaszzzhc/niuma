export { VERSION } from "./src/version.ts";

export { niumaPaths } from "./src/paths.ts";
export type { NiumaPaths } from "./src/paths.ts";

export {
  ConfigError,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT,
  loadConfigFile,
  loadMergedConfig,
  LOG_LEVELS,
  mergeConfig,
  parseConfig,
  parseModelRef,
  PROJECT_CONFIG_BASENAME,
  projectConfigDirs,
  resolveModelRef,
  substituteEnv,
} from "./src/config.ts";
export type {
  CoreConfig,
  LoadMergedOptions,
  LogLevel,
  ModelConfig,
  ProviderConfig,
  ResolvedModel,
  NiumaConfig,
} from "./src/config.ts";

export {
  expandEnvVars,
  loadMcpConfigFile,
  loadMergedMcpConfig,
  MCP_CONFIG_BASENAME,
  McpConfigError,
  mergeMcpConfigs,
  parseMcpConfig,
  WORKSPACE_MCP_CONFIG_BASENAME,
} from "./src/mcp.ts";
export type {
  LoadMergedMcpOptions,
  McpConfig,
  McpServerConfig,
} from "./src/mcp.ts";

export {
  getAuth,
  readAuthFile,
  removeAuth,
  setAuth,
  writeAuthFile,
} from "./src/auth.ts";
export type { ApiAuth, AuthInfo, AuthMap } from "./src/auth.ts";
