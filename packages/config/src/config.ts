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
// Unknown fields are tolerated (forward-compatible), but declared fields
// with the wrong type are rejected — a typo'd `context_window = "128k"`
// failing loudly at startup beats silently falling back to a default.

import { parse as parseToml } from "@std/toml";

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
  readonly baseUrl: string;
  /** Explicit key, or a `{env:VAR}` reference resolved at credential lookup. */
  readonly apiKey?: string;
  readonly models: Readonly<Record<string, ModelConfig>>;
}

export interface CoreConfig {
  readonly logLevel: LogLevel;
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
  const baseUrl = optString(raw, "base_url", path);
  if (!baseUrl) {
    throw new ConfigError(`config: ${path}.base_url is required`);
  }
  const rawModels = raw.models ?? {};
  if (!isRecord(rawModels)) throw typeErr(`${path}.models`, "a table", rawModels);
  const models: Record<string, ModelConfig> = {};
  for (const [modelId, m] of Object.entries(rawModels)) {
    models[modelId] = parseModelConfig(m, `${path}.models.${modelId}`);
  }
  const name = optString(raw, "name", path);
  const apiKey = optString(raw, "api_key", path);
  return {
    id,
    baseUrl: baseUrl.replace(/\/+$/, ""),
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
  const logLevelRaw = optString(rawCore, "log_level", "core") ?? "info";
  if (!(LOG_LEVELS as readonly string[]).includes(logLevelRaw)) {
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
    core: { logLevel: logLevelRaw as LogLevel },
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
  readonly provider: ProviderConfig;
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
  return {
    provider,
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
