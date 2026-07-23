// Credential store: ~/.local/share/niuma/auth.json (mode 0600).
//
// Same convention as opencode (packages/opencode/src/auth/index.ts): a flat
// JSON object keyed by provider id, values tagged by auth type. Only the
// "api" type exists today; the union leaves room for OAuth later.
//
//   {
//     "deepseek": { "type": "api", "key": "sk-..." },
//     "openai":   { "type": "api", "key": "sk-..." }
//   }

export interface ApiAuth {
  readonly type: "api";
  readonly key: string;
}

export type AuthInfo = ApiAuth;
export type AuthMap = Readonly<Record<string, AuthInfo>>;

const isAuthInfo = (v: unknown): v is AuthInfo =>
  typeof v === "object" && v !== null &&
  (v as Record<string, unknown>).type === "api" &&
  typeof (v as Record<string, unknown>).key === "string";

/** Read the whole auth file. A missing file is an empty map; malformed or
 * unrecognised entries are dropped individually (mirrors opencode's
 * filterMap behaviour) so one bad line can't lock out every provider. */
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
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const out: Record<string, AuthInfo> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (isAuthInfo(v)) out[k] = { type: "api", key: v.key };
  }
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
};

export const getAuth = async (
  path: string,
  providerId: string,
): Promise<AuthInfo | undefined> => (await readAuthFile(path))[providerId];

/** Insert/replace one provider's credentials, preserving the rest. */
export const setAuth = async (
  path: string,
  providerId: string,
  info: AuthInfo,
): Promise<void> => {
  const all = { ...(await readAuthFile(path)) };
  all[providerId] = info;
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
