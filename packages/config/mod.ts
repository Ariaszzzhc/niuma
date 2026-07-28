export { VERSION } from "./src/version.ts";

export { niumaPaths } from "./src/paths.ts";
export type { NiumaPaths } from "./src/paths.ts";

export {
  ANTHROPIC_DEFAULT_BASE_URL,
  ConfigError,
  configWriteTarget,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_INPUT_DELIVERY,
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
  resolveModelRef,
  RESPONSES_DEFAULT_BASE_URL,
  substituteEnv,
  writeInputDelivery,
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
  COMMANDS_DIR_BASENAME,
  expandCommandTemplate,
  loadCommands,
  parseCommandFile,
} from "./src/commands.ts";
export type {
  CommandDef,
  CommandTable,
  LoadCommandsOptions,
} from "./src/commands.ts";

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

export {
  BUILTIN_PROVIDERS,
  builtinBaseUrlFor,
  defaultModelRef,
  KIMI_API_BASE_URL,
  KIMI_OAUTH_CLIENT_ID,
  KIMI_OAUTH_HOST,
  KIMI_PLATFORM_BASE_URL,
  KIMI_PLATFORM_DEFAULT_MODEL,
  KIMI_PROVIDER_ID,
  resolveProvider,
} from "./src/builtin.ts";
export type { BuiltinProvider } from "./src/builtin.ts";

export {
  makeKimiDeviceHeaders,
  pollKimiDeviceAuth,
  refreshKimiTokens,
  requestKimiDeviceAuthorization,
} from "./src/kimi_oauth.ts";
export type {
  KimiDeviceAuthorization,
  KimiOAuthOptions,
} from "./src/kimi_oauth.ts";
