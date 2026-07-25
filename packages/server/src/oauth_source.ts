import { Effect } from "effect";
import {
  OAUTH_EXPIRY_SKEW_MS,
  type OAuthAuth,
  setAuth,
  type TokenResponse,
  toOAuthAuth,
} from "@niuma/config";
import { AuthFailed, type OAuthTokenSource } from "@niuma/provider";

// Server-side OAuth token source: the ONLY place the refresh POST + setAuth +
// the in-memory cache meet. The provider package is given an OAuthTokenSource
// and knows nothing about auth.json or refresh (design rule 4); this module
// is the seam that satisfies that interface with codex/opencode-style
// semantics:
//   - proactive refresh: a token expiring within OAUTH_EXPIRY_SKEW_MS is
//     treated as stale and refreshed before it is handed out;
//   - single-flight: at most one refresh POST runs per provider id — concurrent
//     callers (parallel streams, or getAccessToken racing the 401-recovery
//     path) join the in-flight refresh rather than firing a second one;
//   - persistence: each successful refresh is written back through setAuth so
//     the 0600 auth.json stays current (the in-memory cache is authoritative
//     for this process either way);
//   - error surface: a refresh failure (OAuthError from the refresh fn, or a
//     transport error) maps to AuthFailed so the adapter's retry/recovery
//     ladder sees a credential error rather than a rejected promise.
// The refresh POST itself is injected (`deps.refresh`) so the same seam
// serves every issuer — refreshTokens (ChatGPT) or refreshKimiTokens (Kimi).

export interface OAuthTokenSourceDeps {
  /** Path to auth.json — refreshed tokens are persisted here via setAuth. */
  readonly authPath: string;
  /** Provider id the entry is keyed under in auth.json. */
  readonly providerId: string;
  /** The OAuth entry read from auth.json at boot; seeded into the cache. */
  readonly entry: OAuthAuth;
  /** Issuer-specific refresh POST (refreshTokens for ChatGPT,
   * refreshKimiTokens for Kimi). */
  readonly refresh: (refreshToken: string) => Promise<TokenResponse>;
}

const toAuthFailed = (cause: unknown): AuthFailed =>
  new AuthFailed({
    // OAuthError carries the issuer's status/body in its message; non-OAuth
    // transport failures surface their native message. Either way the adapter
    // treats this as a credential error (401-recovery retries once, then
    // propagates AuthFailed to the agent loop).
    message: cause instanceof Error ? cause.message : String(cause),
  });

/**
 * Build an OAuthTokenSource bound to one provider's cached OAuthAuth.
 *
 * The cache is mutated in place as refreshes land; the single-flight guard
 * (`refreshing`) deduplicates concurrent refreshes. `invalidateAndRefresh`
 * (the adapter's 401-recovery path) forces a refresh regardless of staleness
 * but still respects single-flight — if a proactive refresh is already running
 * it joins that rather than issuing a second token POST.
 */
export const makeOAuthTokenSource = (
  deps: OAuthTokenSourceDeps,
): OAuthTokenSource => {
  let cached: OAuthAuth = deps.entry;
  let refreshing: Promise<OAuthAuth> | null = null;

  const runRefresh = (): Promise<OAuthAuth> => {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        // The injected refresh fn keeps the input refresh token when the
        // issuer does not rotate it, so cached.refresh remains usable across
        // non-rotating responses.
        const tokens = await deps.refresh(cached.refresh);
        const auth = toOAuthAuth(tokens);
        cached = auth;
        // Persist best-effort: the in-memory cache is authoritative for this
        // process, so a disk failure (full disk, lost perms) must not fail an
        // otherwise-successful refresh — the next refresh retries the write.
        try {
          await setAuth(deps.authPath, deps.providerId, auth);
        } catch {
          // ignored intentionally — see comment above
        }
        return auth;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  };

  // A token expiring within the skew window is already considered stale
  // (codex's 5-minute convention). `expires === 0` (the always-stale sentinel
  // toOAuthAuth emits when neither expires_in nor a JWT exp was available) is
  // always <= the skew, so the first use refreshes immediately.
  const isStale = (auth: OAuthAuth): boolean =>
    auth.expires - Date.now() <= OAUTH_EXPIRY_SKEW_MS;

  const toResult = (
    auth: OAuthAuth,
  ): { readonly accessToken: string; readonly accountId?: string } => ({
    accessToken: auth.access,
    // accountId is omitted entirely when absent (exactOptionalPropertyTypes:
    // never spread `accountId: undefined`).
    ...(auth.accountId !== undefined ? { accountId: auth.accountId } : {}),
  });

  return {
    getAccessToken: () =>
      Effect.tryPromise({
        try: async () => {
          // Join an in-flight refresh first (single-flight); otherwise serve
          // the cached token while it is still fresh, refreshing only once it
          // enters the skew window.
          if (refreshing) return await runRefresh();
          if (!isStale(cached)) return cached;
          return await runRefresh();
        },
        catch: toAuthFailed,
      }).pipe(Effect.map(toResult)),

    invalidateAndRefresh: () =>
      Effect.tryPromise({
        try: async () => {
          // 401 recovery: force a refresh regardless of staleness. Still
          // single-flight — a concurrent proactive refresh is joined rather
          // than superseded, since its result is a freshly-issued token too.
          return await runRefresh();
        },
        catch: toAuthFailed,
      }).pipe(Effect.map(toResult)),
  };
};
