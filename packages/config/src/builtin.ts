// Built-in providers: login-and-go provider definitions.
//
// `niuma auth login <kimi|openai>` stores credentials in auth.json and nothing
// else — these built-ins make the provider usable with NO [provider.*] table
// in config.toml. A user table with the same id is treated as an overlay on
// the built-in (merge: scalar fields and per-model entries, user wins), which
// is also how a built-in's model limits get tuned. For non-built-in ids the
// user table stands alone (the pre-built-in behaviour).
//
// Model METADATA resolution is deliberately static and network-free:
//   user [provider.x.models.y] → built-in fallback table → global defaults.
// The API is only consulted for the model LIST (the adapters' listModels);
// kimi-code persists /models metadata into its own config to get "API-first"
// metadata, but niuma has no config write-back and the boot path must not be
// gated on network availability.
//
// The built-in kimi provider has TWO credential lanes with different
// endpoints (see builtinBaseUrlFor / defaultModelRef): OAuth → the Kimi Code
// subscription endpoint (api.kimi.com/coding/v1, kimi-for-coding catalogue);
// API key → the Kimi open platform (api.moonshot.cn/v1, pay-as-you-go
// catalogue). A user base_url override always wins for either lane.

// NOTE: only TYPE imports from ./config.ts — config.ts imports this module's
// values (resolveProvider et al.), so any value import evaluated at module
// init would hit the TDZ of a circular import. The numeric literals below
// deliberately mirror DEFAULT_CONTEXT_WINDOW (200_000), DEFAULT_MAX_OUTPUT
// (16_384) and RESPONSES_DEFAULT_BASE_URL from config.ts; keep them in sync.

import type {
  NiumaConfig,
  ModelConfig,
  ProviderConfig,
  ProviderType,
} from "./config.ts";
import type { AuthInfo } from "./auth.ts";

/** Provider id the Kimi device-code login stores its auth.json entry under. */
export const KIMI_PROVIDER_ID = "kimi";
/** Kimi OAuth host (device authorization + token endpoints). */
export const KIMI_OAUTH_HOST = "https://auth.kimi.com";
/** Public Kimi Code CLI client id (shared convention, like the codex one). */
export const KIMI_OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
/** OpenAI-compatible base URL the Kimi OAuth token is valid against. */
export const KIMI_API_BASE_URL = "https://api.kimi.com/coding/v1";
/** Kimi open platform (pay-as-you-go) base URL — where an API-key credential
 * for the built-in kimi provider is sent. The subscription endpoint
 * (KIMI_API_BASE_URL) is the OAuth lane; the API-key lane is the platform
 * (docs: "Kimi Platform — https://api.moonshot.cn/v1"). */
export const KIMI_PLATFORM_BASE_URL = "https://api.moonshot.cn/v1";
/** Default model for the Kimi API-key (open platform) lane — K2.7 Code, the
 * platform's coding model (platform docs / quickstart id `kimi-k2.7-code`). */
export const KIMI_PLATFORM_DEFAULT_MODEL = "kimi-k2.7-code";

export interface BuiltinProvider {
  readonly type: ProviderType;
  readonly baseUrl: string;
  /** Model id used when the built-in is selected without an explicit ref. */
  readonly defaultModel: string;
  /** Fallback metadata table — used only when the user table does not declare
   * the model. Entries are best-effort snapshots of the service catalogue. */
  readonly models: Readonly<Record<string, ModelConfig>>;
}

export const BUILTIN_PROVIDERS: Readonly<Record<string, BuiltinProvider>> = {
  // Kimi (kimi.com coding subscription, device-code OAuth). The fallback entry
  // mirrors kimi-code's /models fixture (context_length 262144 for
  // kimi-for-coding); the live catalogue is server-driven and may drift — the
  // user table overrides any stale value here.
  [KIMI_PROVIDER_ID]: {
    type: "openai",
    baseUrl: KIMI_API_BASE_URL,
    defaultModel: "kimi-for-coding",
    models: {
      "kimi-for-coding": {
        contextWindow: 262_144,
        maxOutput: 16_384, // DEFAULT_MAX_OUTPUT (import cycle — see header)
      },
      // Open-platform lane (API key): K2.7 Code, 256K context; the platform
      // caps max_tokens at 32768 (platform quickstart).
      "kimi-k2.7-code": {
        contextWindow: 262_144,
        maxOutput: 32_768,
      },
    },
  },
  // ChatGPT (OpenAI subscription, PKCE/device OAuth → codex backend). The
  // codex backend exposes no /models, so this id is the de-facto catalogue;
  // limits fall back to the global defaults.
  openai: {
    type: "responses",
    // RESPONSES_DEFAULT_BASE_URL (import cycle — see header).
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5-codex",
    models: {
      "gpt-5-codex": {
        contextWindow: 200_000, // DEFAULT_CONTEXT_WINDOW
        maxOutput: 16_384, // DEFAULT_MAX_OUTPUT
      },
    },
  },
};

/** Resolve the effective provider table for an id: the built-in definition
 * overlaid with the user's `[provider.<id>]` table (user fields win; models
 * merge per model id, user wins). Returns undefined when the id is neither
 * built-in nor user-declared. Non-built-in ids pass through unchanged. */
export const resolveProvider = (
  config: NiumaConfig,
  providerId: string,
): ProviderConfig | undefined => {
  const user = config.providers[providerId];
  const builtin = BUILTIN_PROVIDERS[providerId];
  if (builtin === undefined) return user;
  if (user === undefined) {
    return {
      id: providerId,
      type: builtin.type,
      baseUrl: builtin.baseUrl,
      models: builtin.models,
    };
  }
  return {
    ...user,
    type: user.type ?? builtin.type,
    baseUrl: user.baseUrl ?? builtin.baseUrl,
    models: { ...builtin.models, ...user.models },
  };
};

/** Fallback model ref when neither --model nor config `model` is set: the
 * default model of the UNIQUE built-in provider that has an auth.json entry.
 * Returns undefined when zero (caller keeps its "no model" error) or more
 * than one (ambiguous — the user must pick) built-in is logged in.
 * The default is credential-kind aware: a Kimi API-key entry targets the open
 * platform (KIMI_PLATFORM_DEFAULT_MODEL), an OAuth entry the subscription
 * catalogue. */
export const defaultModelRef = (
  getAuth: (providerId: string) => AuthInfo | undefined,
): string | undefined => {
  const loggedIn = Object.keys(BUILTIN_PROVIDERS).filter((id) =>
    getAuth(id) !== undefined
  );
  if (loggedIn.length !== 1) return undefined;
  const id = loggedIn[0]!;
  if (id === KIMI_PROVIDER_ID && getAuth(id)!.type === "api") {
    return `${id}/${KIMI_PLATFORM_DEFAULT_MODEL}`;
  }
  return `${id}/${BUILTIN_PROVIDERS[id]!.defaultModel}`;
};

/** Effective base URL for a credential-kind-dependent built-in: the Kimi
 * API-key lane targets the open platform, the OAuth lane the subscription
 * endpoint. `userBaseUrl` (a `[provider.kimi] base_url` override) always
 * wins; pass the merged provider's baseUrl as `builtinBaseUrl`. */
export const builtinBaseUrlFor = (
  providerId: string,
  kind: "api" | "oauth",
  builtinBaseUrl: string,
  userBaseUrl?: string,
): string => {
  if (userBaseUrl !== undefined) return userBaseUrl;
  if (providerId === KIMI_PROVIDER_ID && kind === "api") {
    return KIMI_PLATFORM_BASE_URL;
  }
  return builtinBaseUrl;
};
