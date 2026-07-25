// Kimi OAuth device-code flow (RFC 8628) — pure wire plumbing.
//
// Mirrors kimi-code's packages/oauth/src/oauth.ts against auth.kimi.com:
//   POST {host}/api/oauth/device_authorization  {client_id}
//   POST {host}/api/oauth/token                 {client_id, device_code,
//                                                grant_type=device_code}
//   POST {host}/api/oauth/token                 {client_id, refresh_token,
//                                                grant_type=refresh_token}
// All three are form-urlencoded POSTs; the poll understands
// authorization_pending / slow_down / expired_token / access_denied and is
// capped at 15 minutes (same wall-clock budget as the ChatGPT device flow).
//
// Same module rules as oauth.ts: every network call goes through an
// injectable `fetchFn`, nothing here touches auth.json or Deno.env.
// Persistence lives in auth.ts; prompts/polling interaction live in the CLI.
// The X-Msh-* device headers are supplied by the caller via `deviceHeaders`
// (built from makeKimiDeviceHeaders + real host values in the CLI).

import { capBody, OAuthError, sleep, type TokenResponse } from "./oauth.ts";
import { KIMI_OAUTH_CLIENT_ID, KIMI_OAUTH_HOST } from "./builtin.ts";

export interface KimiDeviceAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  /** verification_uri with the user code embedded — the URL to print. */
  readonly verificationUriComplete: string;
  /** Seconds the device code stays valid, when the server reports it. */
  readonly expiresIn?: number;
  /** Poll interval, seconds (server-provided; defaults to 5). */
  readonly interval: number;
}

export interface KimiOAuthOptions {
  readonly fetchFn?: typeof fetch;
  /** X-Msh-* device identification headers (see makeKimiDeviceHeaders). */
  readonly deviceHeaders?: Readonly<Record<string, string>>;
}

const postKimiForm = async (
  url: string,
  params: Record<string, string>,
  opts: KimiOAuthOptions,
  signal?: AbortSignal,
): Promise<Response> => {
  const fetchFn = opts.fetchFn ?? fetch;
  return await fetchFn(url, {
    method: "POST",
    headers: {
      ...opts.deviceHeaders,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(params).toString(),
    ...(signal !== undefined ? { signal } : {}),
  });
};

const readJsonObject = async (
  resp: Response,
  what: string,
): Promise<Record<string, unknown>> => {
  let raw: unknown;
  try {
    raw = await resp.json();
  } catch (e) {
    throw new OAuthError(
      `${what} returned non-JSON body: ${(e as Error).message}`,
      resp.status,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new OAuthError(`${what} returned a non-object response`, resp.status);
  }
  return raw as Record<string, unknown>;
};

/** Request a device code. POST {host}/api/oauth/device_authorization with
 * {client_id}. Required response fields per kimi-code: user_code,
 * device_code, verification_uri_complete. */
export const requestKimiDeviceAuthorization = async (
  opts: KimiOAuthOptions = {},
): Promise<KimiDeviceAuthorization> => {
  const resp = await postKimiForm(
    `${KIMI_OAUTH_HOST}/api/oauth/device_authorization`,
    { client_id: KIMI_OAUTH_CLIENT_ID },
    opts,
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new OAuthError(
      `device authorization failed: status ${resp.status}` +
        (text ? `: ${capBody(text)}` : ""),
      resp.status,
    );
  }
  const r = await readJsonObject(resp, "device authorization response");
  const deviceCode = typeof r.device_code === "string" ? r.device_code : "";
  const userCode = typeof r.user_code === "string" ? r.user_code : "";
  const verificationUriComplete = typeof r.verification_uri_complete ===
      "string"
    ? r.verification_uri_complete
    : "";
  if (deviceCode === "" || userCode === "" || verificationUriComplete === "") {
    throw new OAuthError(
      "device authorization response missing device_code/user_code/verification_uri_complete",
      resp.status,
    );
  }
  const expiresRaw = r.expires_in;
  const intervalRaw = Number(r.interval ?? 5);
  return {
    deviceCode,
    userCode,
    verificationUri: typeof r.verification_uri === "string"
      ? r.verification_uri
      : "",
    verificationUriComplete,
    ...(typeof expiresRaw === "number" && Number.isFinite(expiresRaw)
      ? { expiresIn: expiresRaw }
      : {}),
    interval: Number.isFinite(intervalRaw) && intervalRaw > 0 ? intervalRaw : 5,
  };
};

/** Poll the token endpoint until the user approves the device code.
 * authorization_pending → sleep `interval` and retry; slow_down → +5s on the
 * interval permanently (RFC 8628 §3.5); expired_token / access_denied →
 * OAuthError; 15-minute wall-clock cap. Resolves with the token response on
 * the first 200 carrying access_token. */
export const pollKimiDeviceAuth = async (
  deviceCode: string,
  intervalSec: number,
  opts: KimiOAuthOptions & { signal?: AbortSignal } = {},
): Promise<TokenResponse> => {
  const url = `${KIMI_OAUTH_HOST}/api/oauth/token`;
  let intervalMs = Math.max(intervalSec, 1) * 1000;
  const deadline = Date.now() + 15 * 60 * 1000;
  for (;;) {
    if (opts.signal?.aborted) throw new OAuthError("device auth poll aborted");
    const resp = await postKimiForm(
      url,
      {
        client_id: KIMI_OAUTH_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      },
      opts,
      opts.signal,
    );
    if (resp.ok) {
      const r = await readJsonObject(resp, "device token response");
      if (typeof r.access_token === "string" && r.access_token !== "") {
        return kimiTokenFrom(r, resp.status);
      }
      // 200 without a token is a protocol violation — fail loudly.
      throw new OAuthError(
        "device token response missing access_token",
        resp.status,
      );
    }
    const r = await readJsonObject(resp, "device token response").catch(
      (e) => {
        if (e instanceof OAuthError && resp.status >= 500) throw e;
        return {} as Record<string, unknown>;
      },
    );
    const errorCode = typeof r.error === "string" ? r.error : "";
    const detail = typeof r.error_description === "string"
      ? r.error_description
      : "";
    switch (errorCode) {
      case "authorization_pending":
        break; // sleep and retry below
      case "slow_down":
        intervalMs += 5000;
        break;
      case "expired_token":
        throw new OAuthError(
          "device code expired before approval",
          resp.status,
        );
      case "access_denied":
        throw new OAuthError(
          `sign-in denied${detail ? `: ${capBody(detail)}` : ""}`,
          resp.status,
        );
      default:
        throw new OAuthError(
          `device token poll failed: status ${resp.status}` +
            (errorCode
              ? ` (${errorCode}${detail ? `: ${capBody(detail)}` : ""})`
              : ""),
          resp.status,
        );
    }
    if (Date.now() >= deadline) {
      throw new OAuthError(
        "device auth timed out after 15 minutes",
        resp.status,
      );
    }
    await sleep(Math.min(intervalMs, deadline - Date.now()), opts.signal);
  }
};

/** Build a TokenResponse from a Kimi token payload. refresh_token may be
 * absent on refresh (no rotation) — the caller keeps the old one. */
const kimiTokenFrom = (
  r: Record<string, unknown>,
  status: number,
): TokenResponse => {
  const accessToken = r.access_token;
  if (typeof accessToken !== "string" || accessToken === "") {
    throw new OAuthError("token response missing access_token", status);
  }
  const expiresRaw = r.expires_in;
  return {
    access_token: accessToken,
    // TokenResponse.refresh_token is required by the type (the ChatGPT flow
    // always gets one); Kimi omits it on non-rotating refreshes, so the
    // caller substitutes the previous refresh token — see refreshKimiTokens.
    refresh_token: typeof r.refresh_token === "string" ? r.refresh_token : "",
    ...(typeof expiresRaw === "number" && Number.isFinite(expiresRaw)
      ? { expires_in: expiresRaw }
      : {}),
  };
};

/** Refresh an access token. POST {host}/api/oauth/token
 * grant_type=refresh_token. If the server does not rotate the refresh token
 * (omits it from the response), the input `refreshToken` is kept — same
 * semantics as refreshTokens for the ChatGPT flow. */
export const refreshKimiTokens = async (
  refreshToken: string,
  opts: KimiOAuthOptions = {},
): Promise<TokenResponse> => {
  const resp = await postKimiForm(
    `${KIMI_OAUTH_HOST}/api/oauth/token`,
    {
      client_id: KIMI_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    },
    opts,
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new OAuthError(
      `token refresh failed: status ${resp.status}${
        text ? `: ${capBody(text)}` : ""
      }`,
      resp.status,
    );
  }
  const r = await readJsonObject(resp, "refresh response");
  const t = kimiTokenFrom(r, resp.status);
  return {
    ...t,
    refresh_token: t.refresh_token !== "" ? t.refresh_token : refreshToken,
  };
};

/** Build the X-Msh-* device identification headers Kimi's OAuth endpoints
 * expect (kimi-code sends them on all three requests). All inputs are
 * supplied by the caller so this module stays env-free; the platform is
 * pinned to "kimi_code_cli" to match the client id's registered app. */
export const makeKimiDeviceHeaders = (opts: {
  readonly version: string;
  readonly deviceId: string;
  readonly hostname: string;
  /** e.g. "windows 10.0 x86_64" — OS release + arch. */
  readonly os: string;
}): Record<string, string> => ({
  "X-Msh-Platform": "kimi_code_cli",
  "X-Msh-Version": asciiHeader(opts.version),
  "X-Msh-Device-Name": asciiHeader(opts.hostname),
  "X-Msh-Device-Model": asciiHeader(opts.os),
  "X-Msh-Os-Version": asciiHeader(opts.os),
  "X-Msh-Device-Id": opts.deviceId,
});

/** Header values must be visible ASCII; strip the rest (mirrors kimi-code's
 * asciiHeader) so an exotic hostname cannot corrupt the request. */
const asciiHeader = (value: string): string => {
  const cleaned = value.replaceAll(/[^ -~]/g, "").trim();
  return cleaned.length > 0 ? cleaned : "unknown";
};
