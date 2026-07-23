// TOML configuration for niuma (`~/.config/niuma/config.toml`).
//
// Shape (mirrors opencode's provider/model split, in TOML):
//
//   # Model to use, in {provider}/{model-id} form.
//   model = "deepseek/deepseek-chat"
//
//   [core]
//   log_level = "info"            # trace|debug|info|warning|error|fatal
//
//   [provider.deepseek]
//   name = "DeepSeek"
//   base_url = "https://api.deepseek.com/v1"
//   # api_key is NOT stored here — credentials live in auth.json. The only
//   # escape hatch is an explicit env reference:
//   # api_key = "{env:DEEPSEEK_API_KEY}"
//
//   [provider.deepseek.models.deepseek-chat]
//   context_window = 128000
//   max_output = 8192
//
// A file may also carry a PARTIAL provider table — just `[provider.x.models.y]`
// limits with no base_url — when another file in the merge stack (global
// config.toml or a shallower niuma.toml) defines that provider. base_url is
// only enforced where the provider is actually used (resolveModelRef), which
// always runs against the merged result.
//
// Unknown fields are tolerated (forward-compatible), but declared fields
// with the wrong type are rejected — a typo'd `context_window = "128k"`
// failing loudly at startup beats silently falling back to a default.

import { parse as parseToml } from "@std/toml";
import { dirname, join, resolve } from "@std/path";

const envGet = (name: string): string | undefined => {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
};

const home = (): string =>
  envGet("HOME") ?? envGet("USERPROFILE") ?? Deno.cwd();

/** Project-level config file name, discovered walking up from the workspace. */
export const PROJECT_CONFIG_BASENAME = "niuma.toml";

export const LOG_LEVELS = [
  "trace",
  "debug",
  "info",
  "warning",
  "error",
  "fatal",
] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const DEFAULT_MAX_OUTPUT = 16_384;

export interface ModelConfig {
  readonly contextWindow: number;
  readonly maxOutput: number;
}

export interface ProviderConfig {
  readonly id: string;
  readonly name?: string;
  /** Required in the file that DEFINES the provider; partial project-level
   * tables (limits only) omit it and inherit via mergeConfig. Enforced at
   * resolveModelRef time against the merged config. */
  readonly baseUrl?: string;
  /** Explicit key, or a `{env:VAR}` reference resolved at credential lookup. */
  readonly apiKey?: string;
  readonly models: Readonly<Record<string, ModelConfig>>;
}

export interface CoreConfig {
  /** Undefined when neither the global nor any project file sets log_level
   * (consumers fall back to "info"). Optional — rather than defaulted — so a
   * project-level file can override the global value in mergeConfig. */
  readonly logLevel?: LogLevel;
}

export interface NiumaConfig {
  /** Raw `provider/model-id` reference from the config file, if set. */
  readonly model?: string;
  readonly core: CoreConfig;
  readonly providers: Readonly<Record<string, ProviderConfig>>;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const typeErr = (path: string, expected: string, got: unknown): ConfigError =>
  new ConfigError(
    `config: ${path} must be ${expected}, got ${
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
  return v;
};

const optPositiveInt = (
  obj: Record<string, unknown>,
  key: string,
  path: string,
): number | undefined => {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw typeErr(`${path}.${key}`, "a positive integer", v);
  }
  return v;
};

const parseModelConfig = (
  raw: unknown,
  path: string,
): ModelConfig => {
  if (!isRecord(raw)) throw typeErr(path, "a table", raw);
  return {
    contextWindow: optPositiveInt(raw, "context_window", path) ??
      DEFAULT_CONTEXT_WINDOW,
    maxOutput: optPositiveInt(raw, "max_output", path) ?? DEFAULT_MAX_OUTPUT,
  };
};

const parseProvider = (
  id: string,
  raw: unknown,
): ProviderConfig => {
  const path = `provider.${id}`;
  if (!isRecord(raw)) throw typeErr(path, "a table", raw);
  const rawModels = raw.models ?? {};
  if (!isRecord(rawModels)) throw typeErr(`${path}.models`, "a table", rawModels);
  const models: Record<string, ModelConfig> = {};
  for (const [modelId, m] of Object.entries(rawModels)) {
    models[modelId] = parseModelConfig(m, `${path}.models.${modelId}`);
  }
  const name = optString(raw, "name", path);
  const apiKey = optString(raw, "api_key", path);
  const baseUrl = optString(raw, "base_url", path)?.replace(/\/+$/, "");
  return {
    id,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    models,
  };
};

/** Parse already-read TOML text. Throws ConfigError on bad syntax/types. */
export const parseConfig = (text: string, source = "config.toml"): NiumaConfig => {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (e) {
    throw new ConfigError(
      `config: failed to parse ${source}: ${(e as Error).message}`,
    );
  }
  if (!isRecord(raw)) throw typeErr("(root)", "a table", raw);

  const model = optString(raw, "model", "(root)");

  const rawCore = raw.core ?? {};
  if (!isRecord(rawCore)) throw typeErr("core", "a table", rawCore);
  const logLevelRaw = optString(rawCore, "log_level", "core");
  if (
    logLevelRaw !== undefined &&
    !(LOG_LEVELS as readonly string[]).includes(logLevelRaw)
  ) {
    throw new ConfigError(
      `config: core.log_level must be one of ${LOG_LEVELS.join("|")}, got "${
        logLevelRaw
      }"`,
    );
  }

  const rawProviders = raw.provider ?? {};
  if (!isRecord(rawProviders)) {
    throw typeErr("provider", "a table", rawProviders);
  }
  const providers: Record<string, ProviderConfig> = {};
  for (const [id, p] of Object.entries(rawProviders)) {
    providers[id] = parseProvider(id, p);
  }

  return {
    ...(model !== undefined ? { model } : {}),
    core: {
      ...(logLevelRaw !== undefined
        ? { logLevel: logLevelRaw as LogLevel }
        : {}),
    },
    providers,
  };
};

/** Load and parse a config file; a missing file yields the empty config. */
export const loadConfigFile = async (path: string): Promise<NiumaConfig> => {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return parseConfig("");
    throw new ConfigError(
      `config: failed to read ${path}: ${(e as Error).message}`,
    );
  }
  return parseConfig(text, path);
};

/**
 * Layer `override` on top of `base`. Scalars (model, core.log_level) are
 * replaced when the override sets them; providers are merged per id, and
 * per-model limits per model id, so a project file can add one model's
 * limits without restating the provider's base_url.
 */
export const mergeConfig = (
  base: NiumaConfig,
  override: NiumaConfig,
): NiumaConfig => {
  const providers: Record<string, ProviderConfig> = { ...base.providers };
  for (const [id, p] of Object.entries(override.providers)) {
    const existing = providers[id];
    // baseUrl/name/apiKey inherit from the base when the override's table is
    // partial (limits-only); models merge per id.
    providers[id] = existing
      ? {
        ...existing,
        ...Object.fromEntries(
          Object.entries(p).filter(([k, v]) =>
            k === "id" || (v !== undefined && k !== "models")
          ),
        ),
        models: { ...existing.models, ...p.models },
      }
      : p;
  }
  return {
    ...(override.model !== undefined || base.model !== undefined
      ? { model: override.model ?? base.model! }
      : {}),
    core: {
      ...(
        override.core.logLevel !== undefined ||
          base.core.logLevel !== undefined
          ? { logLevel: override.core.logLevel ?? base.core.logLevel! }
          : {}
      ),
    },
    providers,
  };
};

/** Directories to search for a project niuma.toml, leaf-first, stopping at
 * $HOME (a niuma.toml in $HOME itself is still honoured; nothing above it). */
const projectDirs = (start: string): string[] => {
  const stopAt = resolve(home());
  const dirs: string[] = [];
  let dir = resolve(start);
  for (;;) {
    dirs.push(dir);
    if (dir === stopAt) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
};

export interface LoadMergedOptions {
  /**
   * Directory the project-level search starts from (usually the session
   * workspace). Defaults to NIUMA_WORKSPACE, then Deno.cwd() — matching how
   * the server picks its workspace. Pass an explicit path in tests/CLI.
   */
  readonly projectDir?: string;
}

/**
 * Load the effective config: the global file with every applicable
 * project-level niuma.toml merged on top.
 *
 * Discovery walks from opts.projectDir up to $HOME (opencode's convention;
 * its filename is opencode.json), so running inside a monorepo picks up both
 * the repo root's and the package's niuma.toml. Shallower files are merged
 * first, so the closest directory wins on conflicts; all of them win over
 * the global file.
 */
export const loadMergedConfig = async (
  globalPath: string,
  opts: LoadMergedOptions = {},
): Promise<NiumaConfig> => {
  let config = await loadConfigFile(globalPath);
  const start = opts.projectDir ?? envGet("NIUMA_WORKSPACE") ?? Deno.cwd();
  const files = projectDirs(start).map((dir) =>
    join(dir, PROJECT_CONFIG_BASENAME)
  );
  for (const file of files.reverse()) {
    config = mergeConfig(config, await loadConfigFile(file));
  }
  return config;
};

/**
 * Parse a `provider/model-id` reference. The provider id is everything
 * before the first `/` (model ids may themselves contain `/`, e.g.
 * `openrouter/anthropic/claude-sonnet`).
 */
export const parseModelRef = (
  ref: string,
): { providerId: string; modelId: string } => {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    throw new ConfigError(
      `config: model must be in "provider/model-id" form, got "${ref}"`,
    );
  }
  return { providerId: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
};

export interface ResolvedModel {
  readonly provider: ProviderConfig & { readonly baseUrl: string };
  readonly modelId: string;
  readonly model: ModelConfig;
}

/**
 * Resolve a model reference against the config. The provider must be
 * configured; an undeclared model id gets the default window/output limits
 * (declaring it in the file is how you override those).
 */
export const resolveModelRef = (
  config: NiumaConfig,
  ref: string,
): ResolvedModel => {
  const { providerId, modelId } = parseModelRef(ref);
  const provider = config.providers[providerId];
  if (!provider) {
    const known = Object.keys(config.providers);
    throw new ConfigError(
      `config: provider "${providerId}" is not configured` +
        (known.length > 0 ? ` (configured: ${known.join(", ")})` : ""),
    );
  }
  if (!provider.baseUrl) {
    throw new ConfigError(
      `config: provider "${providerId}" has no base_url. Add one to its ` +
        `[provider.${providerId}] table in config.toml`,
    );
  }
  return {
    provider: provider as ProviderConfig & { readonly baseUrl: string },
    modelId,
    model: provider.models[modelId] ?? {
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxOutput: DEFAULT_MAX_OUTPUT,
    },
  };
};

/** Substitute `{env:VAR_NAME}` references. Unknown vars are left as-is. */
export const substituteEnv = (value: string): string =>
  value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => {
    try {
      return Deno.env.get(name) ?? whole;
    } catch {
      return whole;
    }
  });
