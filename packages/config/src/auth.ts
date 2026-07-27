// Credential store: ~/.niuma/auth.json (mode 0600).
//
// Same convention as opencode (packages/opencode/src/auth/index.ts): a flat
// JSON object keyed by provider id, values tagged by auth type. Two types
// exist today: "api" (a raw key) and "oauth" (ChatGPT-subscription tokens
// obtained via the PKCE/device-code flow in oauth.ts).
//
//   {
//     "deepseek": { "type": "api", "key": "sk-..." },
//     "openai":   {
//       "type": "oauth",
//       "refresh": "...",
//       "access": "...",
//       "expires": 1735689600000,
//       "accountId": "acct-..."
//     }
//   }

export interface ApiAuth {
  readonly type: "api";
  readonly key: string;
}

/** ChatGPT-subscription OAuth credentials. `expires` is the epoch-ms of the
 * access token's expiry (issued-at + expires_in*1000, or the JWT `exp` claim
 * when the token endpoint omits expires_in); refresh logic treats
 * exp-within-OAUTH_EXPIRY_SKEW_MS as stale. `accountId` is the ChatGPT
 * account id extracted from JWT claims and sent as the ChatGPT-Account-Id
 * header. Both are produced by oauth.ts::toOAuthAuth — the store holds them
 * verbatim and never re-decodes tokens itself. */
export interface OAuthAuth {
  readonly type: "oauth";
  readonly refresh: string;
  readonly access: string;
  readonly expires: number;
  readonly accountId?: string;
}

export type AuthInfo = ApiAuth | OAuthAuth;
export type AuthMap = Readonly<Record<string, AuthInfo>>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isApiAuth = (v: unknown): v is ApiAuth =>
  isRecord(v) && v.type === "api" && typeof v.key === "string";

const isOAuthAuth = (v: unknown): v is OAuthAuth =>
  isRecord(v) &&
  v.type === "oauth" &&
  typeof v.refresh === "string" &&
  typeof v.access === "string" &&
  typeof v.expires === "number" && Number.isFinite(v.expires) &&
  (v.accountId === undefined || typeof v.accountId === "string");

/** Two-branch narrowing: an api entry needs a string key; an oauth entry
 * needs string refresh/access plus a finite numeric expires (accountId is
 * optional but, when present, must be a string). */
const isAuthInfo = (v: unknown): v is AuthInfo =>
  isApiAuth(v) || isOAuthAuth(v);

/** Copy only the declared fields, so stray keys on a hand-edited entry do
 * not survive a read/write round-trip (and exactOptionalPropertyTypes is
 * satisfied: accountId is omitted entirely when absent). */
const normalize = (info: AuthInfo): AuthInfo => {
  if (info.type === "api") return { type: "api", key: info.key };
  const { type, refresh, access, expires, accountId } = info;
  return accountId !== undefined
    ? { type, refresh, access, expires, accountId }
    : { type, refresh, access, expires };
};

const deleteCorruptAuthFile = async (path: string): Promise<void> => {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
};

/** Read the whole auth file. A missing file is an empty map. A malformed root
 * deletes the whole file; invalid entries in an object are deleted by
 * rewriting only the independently valid credentials. */
export const readAuthFile = async (path: string): Promise<AuthMap> => {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return {};
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    await deleteCorruptAuthFile(path);
    return {};
  }
  if (!isRecord(parsed)) {
    await deleteCorruptAuthFile(path);
    return {};
  }
  const out: Record<string, AuthInfo> = {};
  let changed = false;
  for (const [key, value] of Object.entries(parsed)) {
    if (!isAuthInfo(value)) {
      changed = true;
      continue;
    }
    const normalized = normalize(value);
    out[key] = normalized;
    if (JSON.stringify(value) !== JSON.stringify(normalized)) changed = true;
  }
  if (changed) await writeAuthFile(path, out);
  return out;
};

/** Write the auth file with 0600 permissions (credentials at rest). */
export const writeAuthFile = async (
  path: string,
  auth: AuthMap,
): Promise<void> => {
  await Deno.writeTextFile(path, JSON.stringify(auth, null, 2) + "\n", {
    mode: 0o600,
  });
  if (Deno.build.os !== "windows") await Deno.chmod(path, 0o600);
};

export const getAuth = async (
  path: string,
  providerId: string,
): Promise<AuthInfo | undefined> => (await readAuthFile(path))[providerId];

/** Insert/replace one provider's credentials, preserving the rest. The value
 * is normalized so the write path enforces the same declared-fields-only
 * invariant as the read path — a caller that builds an AuthInfo with stray
 * keys (or an explicit `accountId: undefined`) cannot pollute the 0600 file,
 * which would otherwise survive until the next read strips them. */
export const setAuth = async (
  path: string,
  providerId: string,
  info: AuthInfo,
): Promise<void> => {
  const all = { ...(await readAuthFile(path)) };
  all[providerId] = normalize(info);
  await writeAuthFile(path, all);
};

export const removeAuth = async (
  path: string,
  providerId: string,
): Promise<void> => {
  const all = { ...(await readAuthFile(path)) };
  delete all[providerId];
  await writeAuthFile(path, all);
};
