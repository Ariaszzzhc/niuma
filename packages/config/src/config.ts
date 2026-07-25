// TOML configuration for niuma (`~/.niuma/config.toml`).
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
// config.toml or a shallower .niuma/config.toml) defines that provider. base_url is
// only enforced where the provider is actually used (resolveModelRef), which
// always runs against the merged result.
//
// Unknown fields are tolerated (forward-compatible), but declared fields
// with the wrong type are rejected — a typo'd `context_window = "128k"`
// failing loudly at startup beats silently falling back to a default.

import { parse as parseToml } from "@std/toml";
import { dirname, join, resolve } from "@std/path";
import { BUILTIN_PROVIDERS, resolveProvider } from "./builtin.ts";

const envGet = (name: string): string | undefined => {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
};

const home = (): string =>
  envGet("HOME") ?? envGet("USERPROFILE") ?? Deno.cwd();

/** Project-level directory name: config and resources live in
 * `<dir>/.niuma/` for every dir on the projectConfigDirs path. Data
 * (sessions, db, logs) NEVER goes here — user-level ~/.niuma only. */
export const PROJECT_DIR_BASENAME = ".niuma";

/** Project-level config file: `<dir>/.niuma/config.toml`. */
export const PROJECT_CONFIG_BASENAME = "config.toml";

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
  /** Provider-defined reasoning effort档位 (legal values are part of each
   * provider's wire protocol). Passed through verbatim — niuma defines no enum.
   * Absent when the model table sets no `thinking_effort`. */
  readonly thinkingEffort?: string;
  /** Whether prior reasoning is replayed back to the provider on follow-up
   * turns ("all", the default behaviour when unset; "none" strips it at the
   * context projection layer). Absent when the model table sets no
   * `thinking_keep`. */
  readonly thinkingKeep?: "all" | "none";
}

export interface ProviderConfig {
  readonly id: string;
  readonly name?: string;
  /** Wire-protocol flavour this provider speaks. Defaults to "openai" when
   * the provider table is partial (limits-only); the resolver / bootstrap
   * falls back to the same default when the field is absent. Free string
   * names would be more permissive, but a closed set lets the bootstrap
   * dispatch without a runtime "unknown protocol" branch. */
  readonly type?: ProviderType;
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

const THINKING_KEEP_VALUES = ["all", "none"] as const;
const optThinkingKeep = (
  obj: Record<string, unknown>,
  key: string,
  path: string,
): "all" | "none" | undefined => {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (
    typeof v !== "string" ||
    !(THINKING_KEEP_VALUES as readonly string[]).includes(v)
  ) {
    throw new ConfigError(
      `config: ${path}.${key} must be one of ${
        THINKING_KEEP_VALUES.join("|")
      }, got ${typeof v === "string" ? `"${v}"` : typeof v}`,
    );
  }
  return v as "all" | "none";
};

/** Wire-protocol flavours a provider can speak. niuma core only knows how to
 * dispatch on this label; the legal values themselves are config-level
 * vocabulary (mirrors how `thinking_effort` is a free string). */
export const PROVIDER_TYPES = ["openai", "anthropic", "responses"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

/** Canonical endpoint for the anthropic flavour when the provider table
 * leaves base_url unset. Lives next to the type vocabulary so config and
 * bootstrap share one default. */
export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";

/** Canonical endpoint for the responses flavour (OpenAI Responses API) when
 * the provider table leaves base_url unset. The OAuth rewrite target
 * (chatgpt.com/backend-api/codex/responses) is wire-protocol knowledge and
 * lives in the provider package, NOT here — config only knows the api.openai.com
 * default, mirroring ANTHROPIC_DEFAULT_BASE_URL. */
export const RESPONSES_DEFAULT_BASE_URL = "https://api.openai.com/v1";

const optProviderType = (
  obj: Record<string, unknown>,
  key: string,
  path: string,
): ProviderType | undefined => {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (
    typeof v !== "string" || !(PROVIDER_TYPES as readonly string[]).includes(v)
  ) {
    throw new ConfigError(
      `config: ${path}.${key} must be one of ${PROVIDER_TYPES.join("|")}, got ${
        typeof v === "string" ? `"${v}"` : typeof v
      }`,
    );
  }
  return v as ProviderType;
};

const parseModelConfig = (
  raw: unknown,
  path: string,
): ModelConfig => {
  if (!isRecord(raw)) throw typeErr(path, "a table", raw);
  // Optional thinking fields are only attached when declared, so the merge
  // step can inherit them from a shallower config file (mirrors how
  // name/baseUrl/apiKey are attached at the provider level).
  const thinkingEffort = optString(raw, "thinking_effort", path);
  const thinkingKeep = optThinkingKeep(raw, "thinking_keep", path);
  return {
    contextWindow: optPositiveInt(raw, "context_window", path) ??
      DEFAULT_CONTEXT_WINDOW,
    maxOutput: optPositiveInt(raw, "max_output", path) ?? DEFAULT_MAX_OUTPUT,
    ...(thinkingEffort !== undefined ? { thinkingEffort } : {}),
    ...(thinkingKeep !== undefined ? { thinkingKeep } : {}),
  };
};

const parseProvider = (
  id: string,
  raw: unknown,
): ProviderConfig => {
  const path = `provider.${id}`;
  if (!isRecord(raw)) throw typeErr(path, "a table", raw);
  const rawModels = raw.models ?? {};
  if (!isRecord(rawModels)) {
    throw typeErr(`${path}.models`, "a table", rawModels);
  }
  const models: Record<string, ModelConfig> = {};
  for (const [modelId, m] of Object.entries(rawModels)) {
    models[modelId] = parseModelConfig(m, `${path}.models.${modelId}`);
  }
  const name = optString(raw, "name", path);
  const type = optProviderType(raw, "type", path);
  const apiKey = optString(raw, "api_key", path);
  const baseUrl = optString(raw, "base_url", path)?.replace(/\/+$/, "");
  return {
    id,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    models,
  };
};

/** Parse already-read TOML text. Throws ConfigError on bad syntax/types. */
export const parseConfig = (
  text: string,
  source = "config.toml",
): NiumaConfig => {
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
      `config: core.log_level must be one of ${
        LOG_LEVELS.join("|")
      }, got "${logLevelRaw}"`,
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
 *
 * Per-model fields merge deeply: an override that declares a model inherits
 * the base model's optional fields (thinking_effort/thinking_keep) when it
 * does not itself set them, and replaces only the fields it declares.
 * Required fields (context_window/max_output) are always present on both
 * sides after parsing, so the override wins as before.
 */
export const mergeConfig = (
  base: NiumaConfig,
  override: NiumaConfig,
): NiumaConfig => {
  const providers: Record<string, ProviderConfig> = { ...base.providers };
  for (const [id, p] of Object.entries(override.providers)) {
    const existing = providers[id];
    // baseUrl/name/apiKey/type inherit from the base when the override's
    // table is partial (limits-only); models merge per id.
    providers[id] = existing
      ? {
        ...existing,
        ...Object.fromEntries(
          Object.entries(p).filter(([k, v]) =>
            k === "id" || (v !== undefined && k !== "models")
          ),
        ),
        models: mergeModels(existing.models, p.models),
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

/** Per-model deep merge: override fields win, base fields (including the
 * optional thinking_effort/thinking_keep) are preserved when the override's
 * model entry leaves them unset. */
const mergeModels = (
  base: Readonly<Record<string, ModelConfig>>,
  override: Readonly<Record<string, ModelConfig>>,
): Record<string, ModelConfig> => {
  const out: Record<string, ModelConfig> = { ...base };
  for (const [modelId, m] of Object.entries(override)) {
    const b = base[modelId];
    out[modelId] = b ? { ...b, ...m } : m;
  }
  return out;
};

/** Directories to search for a project .niuma/ dir, leaf-first, stopping at
 * $HOME (a .niuma/ in $HOME itself is still honoured; nothing above it).
 * Exported as the shared project-config discovery path — also used by the
 * mcp.json loader (src/mcp.ts) for its level-2 files. */
export const projectConfigDirs = (start: string): string[] => {
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
 * project-level .niuma/config.toml merged on top.
 *
 * Discovery walks from opts.projectDir up to $HOME (opencode's convention;
 * its filename is opencode.json), so running inside a monorepo picks up both
 * the repo root's and the package's .niuma/config.toml. Shallower files are
 * merged first, so the closest directory wins on conflicts; all of them win
 * over the global file.
 */
export const loadMergedConfig = async (
  globalPath: string,
  opts: LoadMergedOptions = {},
): Promise<NiumaConfig> => {
  let config = await loadConfigFile(globalPath);
  const start = opts.projectDir ?? envGet("NIUMA_WORKSPACE") ?? Deno.cwd();
  const files = projectConfigDirs(start).map((dir) =>
    join(dir, PROJECT_DIR_BASENAME, PROJECT_CONFIG_BASENAME)
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
 * configured — either declared in a `[provider.*]` table or built in
 * (resolveProvider merges the two, user fields win); an undeclared model id
 * gets the default window/output limits (declaring it in the file is how you
 * override those).
 */
export const resolveModelRef = (
  config: NiumaConfig,
  ref: string,
): ResolvedModel => {
  const { providerId, modelId } = parseModelRef(ref);
  const provider = resolveProvider(config, providerId);
  if (!provider) {
    const known = [
      ...Object.keys(BUILTIN_PROVIDERS),
      ...Object.keys(config.providers),
    ];
    throw new ConfigError(
      `config: provider "${providerId}" is not configured` +
        (known.length > 0 ? ` (available: ${known.join(", ")})` : ""),
    );
  }
  // base_url is required for the default openai flavour; anthropic and
  // responses providers may omit it and fall back to the protocol's canonical
  // host (the bootstrap substitutes ANTHROPIC_DEFAULT_BASE_URL or
  // RESPONSES_DEFAULT_BASE_URL when the table leaves it unset).
  const defaultBase = provider.type === "anthropic"
    ? ANTHROPIC_DEFAULT_BASE_URL
    : provider.type === "responses"
    ? RESPONSES_DEFAULT_BASE_URL
    : undefined;
  const baseUrl = provider.baseUrl ?? defaultBase;
  if (!baseUrl) {
    throw new ConfigError(
      `config: provider "${providerId}" has no base_url. Add one to its ` +
        `[provider.${providerId}] table in config.toml`,
    );
  }
  return {
    provider: { ...provider, baseUrl },
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
