export const CONFIG_VERSION = "0.0.0";

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
  getAuth,
  readAuthFile,
  removeAuth,
  setAuth,
  writeAuthFile,
} from "./src/auth.ts";
export type { ApiAuth, AuthInfo, AuthMap } from "./src/auth.ts";
