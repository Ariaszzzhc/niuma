export { VERSION } from "./src/version.ts";

export { niumaPaths } from "./src/paths.ts";
export type { NiumaPaths } from "./src/paths.ts";

export {
  ANTHROPIC_DEFAULT_BASE_URL,
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
  PROJECT_DIR_BASENAME,
  projectConfigDirs,
  PROVIDER_TYPES,
  RESPONSES_DEFAULT_BASE_URL,
  resolveModelRef,
  substituteEnv,
} from "./src/config.ts";
export type {
  NiumaConfig,
  CoreConfig,
  LoadMergedOptions,
  LogLevel,
  ModelConfig,
  ProviderConfig,
  ProviderType,
  ResolvedModel,
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
export type { ApiAuth, AuthInfo, AuthMap, OAuthAuth } from "./src/auth.ts";

export {
  buildAuthorizeUrl,
  exchangeCode,
  extractAccountId,
  generatePkce,
  OAUTH_CLIENT_ID,
  OAUTH_EXPIRY_SKEW_MS,
  OAUTH_ISSUER,
  OAUTH_PORT,
  OAUTH_REDIRECT_URI,
  OAuthError,
  parseJwtClaims,
  pollDeviceAuth,
  randomState,
  refreshTokens,
  requestDeviceCode,
  toOAuthAuth,
} from "./src/oauth.ts";
export type {
  DeviceCodeResponse,
  ExchangeCodeOptions,
  IdTokenClaims,
  PkceCodes,
  TokenResponse,
} from "./src/oauth.ts";
