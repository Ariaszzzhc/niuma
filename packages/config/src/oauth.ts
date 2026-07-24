// OpenAI/ChatGPT OAuth flow: PKCE + device-code + token exchange/refresh.
//
// Public convention shared with codex (codex-rs/login) and opencode
// (packages/opencode/.../openai/codex.ts): the same CLIENT_ID, issuer,
// loopback redirect on :1455, S256 PKCE, and the device-code poll against
// /api/accounts/deviceauth. niuma points the originator param at itself.
//
// This module is PURE plumbing: every network call goes through an injectable
// `fetchFn` (tests pass a stub, production passes the global), and nothing
// here touches auth.json or Deno.env. Persistence lives in auth.ts; the
// loopback callback server and browser interaction live in the CLI. The
// ChatGPT backend rewrite target (chatgpt.com/backend-api/codex/responses)
// is wire-protocol knowledge and deliberately NOT defined here — it belongs
// to the provider package.

import { decodeBase64Url, encodeBase64Url } from "@std/encoding";
import type { OAuthAuth } from "./auth.ts";

/** Public Codex/ChatGPT CLI client id (same as codex & opencode). */
export const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
/** OpenAI auth issuer. */
export const OAUTH_ISSUER = "https://auth.openai.com";
/** Loopback redirect_uri for the browser PKCE flow. */
export const OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback";
/** Port the CLI's one-shot callback server binds (127.0.0.1). */
export const OAUTH_PORT = 1455;
/** Proactive-refresh skew: an access token expiring within this window is
 * treated as already expired (codex's 5-minute convention). Consumed by the
 * server-side token source, not by this module. */
export const OAUTH_EXPIRY_SKEW_MS = 5 * 60 * 1000;

/** RFC 7636 unreserved set; the verifier is drawn from it so the challenge
 * round-trips through any standards-strict authorizer. */
const PKCE_VERIFIER_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

export interface PkceCodes {
  /** 43-char unreserved-set verifier. */
  readonly verifier: string;
  /** base64url(SHA-256(verifier)), no padding. */
  readonly challenge: string;
}

/** Generate a PKCE pair: a 43-char verifier over the unreserved set plus its
 * S256 challenge. The verifier length (43) is the RFC minimum and matches
 * opencode; the challenge is base64url without padding. */
export const generatePkce = async (): Promise<PkceCodes> => {
  const chars = PKCE_VERIFIER_CHARS;
  // Rejection sample so each char is uniformly likely: 256 % 66 = 58, so a
  // naive `byte % 66` skews the first 58 chars ~1.08x over the last 8.
  // Rejecting bytes >= 198 (66 * floor(256/66)) leaves exactly 198 accepted
  // values (3 per char) — uniform, matching the standards-strict idiom
  // codex/opencode use. Expected overhead is ~30% extra bytes drawn.
  const rejectAbove = 256 - (256 % chars.length);
  let verifier = "";
  while (verifier.length < 43) {
    // Draw a batch; the loop redraws only if (very unlikely) 64 accepted
    // samples do not cover 43 chars.
    const buf = crypto.getRandomValues(new Uint8Array(64));
    for (let i = 0; i < buf.length && verifier.length < 43; i++) {
      const b = buf[i]!;
      if (b < rejectAbove) verifier += chars[b % chars.length]!;
    }
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: encodeBase64Url(new Uint8Array(digest)) };
};

/** Random `state` parameter: base64url(16 random bytes), no padding. */
export const randomState = (): string =>
  encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)));

/** Build the authorize URL. scope is the ChatGPT offline-access set; PKCE is
 * S256; originator is stamped "niuma" so the issuer sees this client. */
export const buildAuthorizeUrl = (pkce: PkceCodes, state: string): string => {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "niuma",
  });
  return `${OAUTH_ISSUER}/oauth/authorize?${params.toString()}`;
};

/** Non-2xx from a token/device endpoint. `status` is the HTTP status when the
 * server responded (absent for transport failures the caller lets propagate). */
export class OAuthError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "OAuthError";
    if (status !== undefined) this.status = status;
  }
}

/** Cap an interpolated response body before it lands in an error message.
 * Defense-in-depth: the issuer is pinned and reached over TLS, but if an error
 * body ever echoed a request parameter (refresh_token, code_verifier) the cap
 * keeps it out of terminal output / logs. 200 chars is enough to preserve the
 * useful `error`/`error_description` fields codex/opencode surface. */
const capBody = (text: string): string =>
  text.length > 200 ? `${text.slice(0, 200)}…` : text;

export interface TokenResponse {
  /** id_token carries the account claims; absent when the issuer omits it. */
  readonly id_token?: string;
  readonly access_token: string;
  readonly refresh_token: string;
  /** Seconds until the access token expires, when the issuer returns it. */
  readonly expires_in?: number;
}

/** Loose shape decoded from the token endpoint before the required fields are
 * checked. Fields are `string | undefined` (not optional) so callers can build
 * a clean TokenResponse with conditional spreads under exactOptionalPropertyTypes. */
interface RawTokens {
  readonly access_token: string | undefined;
  readonly refresh_token: string | undefined;
  readonly id_token: string | undefined;
  readonly expires_in: number | undefined;
}

const readTokenJson = async (resp: Response): Promise<RawTokens> => {
  let raw: unknown;
  try {
    raw = await resp.json();
  } catch (e) {
    throw new OAuthError(
      `token endpoint returned non-JSON body: ${(e as Error).message}`,
      resp.status,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new OAuthError("token endpoint returned a non-object response", resp.status);
  }
  const r = raw as Record<string, unknown>;
  const expiresRaw = r.expires_in;
  return {
    access_token: typeof r.access_token === "string" ? r.access_token : undefined,
    refresh_token: typeof r.refresh_token === "string" ? r.refresh_token : undefined,
    id_token: typeof r.id_token === "string" ? r.id_token : undefined,
    expires_in: typeof expiresRaw === "number" && Number.isFinite(expiresRaw)
      ? expiresRaw
      : undefined,
  };
};

/** Build a clean TokenResponse, omitting absent optional fields entirely. */
const toTokenResponse = (t: RawTokens): TokenResponse => ({
  access_token: t.access_token!,
  refresh_token: t.refresh_token!,
  ...(t.id_token !== undefined ? { id_token: t.id_token } : {}),
  ...(t.expires_in !== undefined ? { expires_in: t.expires_in } : {}),
});

export interface ExchangeCodeOptions {
  readonly fetchFn?: typeof fetch;
  /** Override the redirect_uri (the device flow exchanges with
   * `{issuer}/deviceauth/callback` rather than the loopback URL). */
  readonly redirectUri?: string;
}

/** Exchange an authorization code for tokens. POST {issuer}/oauth/token,
 * form-urlencoded grant_type=authorization_code. Only `pkce.verifier` is read.
 * Throws OAuthError (with status) on non-2xx. */
export const exchangeCode = async (
  code: string,
  pkce: PkceCodes,
  opts: ExchangeCodeOptions = {},
): Promise<TokenResponse> => {
  const fetchFn = opts.fetchFn ?? fetch;
  const redirectUri = opts.redirectUri ?? OAUTH_REDIRECT_URI;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: OAUTH_CLIENT_ID,
    code_verifier: pkce.verifier,
  });
  const resp = await fetchFn(`${OAUTH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new OAuthError(
      `token exchange failed: status ${resp.status}${text ? `: ${capBody(text)}` : ""}`,
      resp.status,
    );
  }
  const t = await readTokenJson(resp);
  if (t.access_token === undefined || t.refresh_token === undefined) {
    throw new OAuthError(
      "token response missing access_token or refresh_token",
      resp.status,
    );
  }
  return toTokenResponse(t);
};

/** Refresh an access token. POST {issuer}/oauth/token grant_type=refresh_token.
 * If the issuer does not rotate the refresh token (omits it from the response),
 * the input `refreshToken` is kept so the stored credential stays usable. */
export const refreshTokens = async (
  refreshToken: string,
  opts: { fetchFn?: typeof fetch } = {},
): Promise<TokenResponse> => {
  const fetchFn = opts.fetchFn ?? fetch;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
  });
  const resp = await fetchFn(`${OAUTH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new OAuthError(
      `token refresh failed: status ${resp.status}${text ? `: ${capBody(text)}` : ""}`,
      resp.status,
    );
  }
  const t = await readTokenJson(resp);
  if (t.access_token === undefined) {
    throw new OAuthError("refresh response missing access_token", resp.status);
  }
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? refreshToken,
    ...(t.id_token !== undefined ? { id_token: t.id_token } : {}),
    ...(t.expires_in !== undefined ? { expires_in: t.expires_in } : {}),
  };
};

export interface DeviceCodeResponse {
  readonly deviceAuthId: string;
  readonly userCode: string;
  /** Poll interval, seconds. */
  readonly interval: number;
}

/** Request a device code (headless flow). POST {issuer}/api/accounts/deviceauth/
 * usercode with {client_id}. `interval` arrives as a string from the issuer
 * (codex deserializes it that way) and is parsed to a number here. */
export const requestDeviceCode = async (
  opts: { fetchFn?: typeof fetch } = {},
): Promise<DeviceCodeResponse> => {
  const fetchFn = opts.fetchFn ?? fetch;
  const resp = await fetchFn(
    `${OAUTH_ISSUER}/api/accounts/deviceauth/usercode`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: OAUTH_CLIENT_ID }),
    },
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new OAuthError(
      `device code request failed: status ${resp.status}${text ? `: ${capBody(text)}` : ""}`,
      resp.status,
    );
  }
  let raw: unknown;
  try {
    raw = await resp.json();
  } catch (e) {
    throw new OAuthError(
      `device code response was not JSON: ${(e as Error).message}`,
      resp.status,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new OAuthError("device code response was not an object", resp.status);
  }
  const r = raw as Record<string, unknown>;
  const deviceAuthId = typeof r.device_auth_id === "string"
    ? r.device_auth_id
    : undefined;
  const userCodeRaw = r.user_code ?? r.usercode;
  const userCode = typeof userCodeRaw === "string" ? userCodeRaw : undefined;
  // codex/opencode receive interval as a string; accept either spelling.
  const intervalRaw = r.interval;
  const interval = typeof intervalRaw === "number" && Number.isFinite(intervalRaw)
    ? intervalRaw
    : typeof intervalRaw === "string" && /^\d+$/.test(intervalRaw.trim())
    ? parseInt(intervalRaw, 10)
    : undefined;
  if (deviceAuthId === undefined || userCode === undefined || interval === undefined) {
    throw new OAuthError(
      "device code response missing device_auth_id/user_code/interval",
      resp.status,
    );
  }
  return { deviceAuthId, userCode, interval };
};

/** Resolve `ms` from now, clamped to `deadline`. Resolves immediately if the
 * signal is already aborted (the caller's next fetch then surfaces the abort). */
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/** Poll the device-auth token endpoint until the user completes the flow.
 * 403/404 = pending (sleep `interval` and retry); 2xx returns the code +
 * server-provided verifier for a follow-up exchangeCode with
 * redirect_uri={issuer}/deviceauth/callback. Mirrors codex's 15-minute cap so
 * a forgotten headless login cannot hang forever. Aborts cleanly via `signal`. */
export const pollDeviceAuth = async (
  deviceAuthId: string,
  userCode: string,
  intervalSec: number,
  opts: { fetchFn?: typeof fetch; signal?: AbortSignal } = {},
): Promise<{ code: string; verifier: string }> => {
  const fetchFn = opts.fetchFn ?? fetch;
  const url = `${OAUTH_ISSUER}/api/accounts/deviceauth/token`;
  const intervalMs = Math.max(intervalSec, 1) * 1000;
  const deadline = Date.now() + 15 * 60 * 1000;
  for (;;) {
    if (opts.signal?.aborted) throw new OAuthError("device auth poll aborted");
    const resp = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    if (resp.ok) {
      let raw: unknown;
      try {
        raw = await resp.json();
      } catch (e) {
        throw new OAuthError(
          `device auth token response was not JSON: ${(e as Error).message}`,
          resp.status,
        );
      }
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new OAuthError(
          "device auth token response was not an object",
          resp.status,
        );
      }
      const r = raw as Record<string, unknown>;
      const code = typeof r.authorization_code === "string"
        ? r.authorization_code
        : undefined;
      const verifier = typeof r.code_verifier === "string"
        ? r.code_verifier
        : undefined;
      if (code === undefined || verifier === undefined) {
        throw new OAuthError(
          "device auth response missing authorization_code/code_verifier",
          resp.status,
        );
      }
      return { code, verifier };
    }
    if (resp.status === 403 || resp.status === 404) {
      // Still pending — consume the body so the connection can be reused.
      await resp.text().catch(() => {});
      if (Date.now() >= deadline) {
        throw new OAuthError("device auth timed out after 15 minutes", resp.status);
      }
      await sleep(Math.min(intervalMs, deadline - Date.now()), opts.signal);
      continue;
    }
    const text = await resp.text().catch(() => "");
    throw new OAuthError(
      `device auth poll failed: status ${resp.status}${text ? `: ${capBody(text)}` : ""}`,
      resp.status,
    );
  }
};

export interface IdTokenClaims {
  readonly chatgpt_account_id?: string;
  readonly organizations?: ReadonlyArray<{ readonly id: string }>;
  readonly "https://api.openai.com/auth"?: { readonly chatgpt_account_id?: string };
}

/** Decode a JWT's payload to a raw record (no signature verification — these
 * tokens are only ever consumed over TLS from the issuer we just hit). Returns
 * undefined for anything that is not a three-part JWT with decodable JSON. */
const decodeJwt = (token: string): Record<string, unknown> | undefined => {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const json = new TextDecoder().decode(decodeBase64Url(parts[1]!));
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

/** Extract the typed claim subset niuma cares about. Drops unrelated fields so
 * downstream code reads a clean object. */
export const parseJwtClaims = (token: string): IdTokenClaims | undefined => {
  const raw = decodeJwt(token);
  if (!raw) return undefined;
  const auth = typeof raw["https://api.openai.com/auth"] === "object" &&
      raw["https://api.openai.com/auth"] !== null
    ? raw["https://api.openai.com/auth"] as Record<string, unknown>
    : undefined;
  const authAccountId = auth !== undefined &&
      typeof auth.chatgpt_account_id === "string"
    ? auth.chatgpt_account_id
    : undefined;
  const organizations = Array.isArray(raw.organizations)
    ? raw.organizations
      .filter(
        (o): o is { id: string } =>
          typeof o === "object" && o !== null &&
          typeof (o as Record<string, unknown>).id === "string",
      )
      .map((o) => ({ id: (o as { id: string }).id }))
    : undefined;
  return {
    ...(typeof raw.chatgpt_account_id === "string"
      ? { chatgpt_account_id: raw.chatgpt_account_id }
      : {}),
    ...(organizations !== undefined ? { organizations } : {}),
    ...(authAccountId !== undefined
      ? { "https://api.openai.com/auth": { chatgpt_account_id: authAccountId } }
      : {}),
  };
};

/** Standard JWT `exp` (seconds since epoch) → epoch-ms, or undefined. */
const jwtExpMs = (token: string): number | undefined => {
  const raw = decodeJwt(token);
  if (!raw) return undefined;
  const exp = raw.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
};

/** Account-id precedence within one token's claims: namespaced auth claim
 * first (codex's AuthClaims path), then the flat claim, then the first
 * organization id. NOTE: namespaced precedes flat per the binding contract;
 * opencode reads flat first, but codex's parse_chatgpt_jwt_claims reads the
 * namespaced AuthClaims, and the architect's contract mandates this order. */
const accountIdFromClaims = (claims: IdTokenClaims): string | undefined =>
  claims["https://api.openai.com/auth"]?.chatgpt_account_id ??
    claims.chatgpt_account_id ??
    claims.organizations?.[0]?.id;

/** Extract the ChatGPT account id from a token response, preferring the
 * id_token and falling back to the access_token. */
export const extractAccountId = (tokens: TokenResponse): string | undefined => {
  const fromToken = (token: string | undefined): string | undefined => {
    if (!token) return undefined;
    const claims = parseJwtClaims(token);
    return claims ? accountIdFromClaims(claims) : undefined;
  };
  return fromToken(tokens.id_token) ?? fromToken(tokens.access_token);
};

/** Convert a token response into the stored OAuthAuth shape.
 *
 * expires = now + expires_in*1000 when the issuer returns expires_in; else
 * the access_token JWT `exp` (ms); else 0 (always-stale, so the first use
 * refreshes immediately). accountId is extracted per the precedence above and
 * omitted entirely when absent. */
export const toOAuthAuth = (tokens: TokenResponse): OAuthAuth => {
  const expires = tokens.expires_in !== undefined
    ? Date.now() + tokens.expires_in * 1000
    : jwtExpMs(tokens.access_token) ?? 0;
  const accountId = extractAccountId(tokens);
  return {
    type: "oauth",
    refresh: tokens.refresh_token,
    access: tokens.access_token,
    expires,
    ...(accountId !== undefined ? { accountId } : {}),
  };
};
