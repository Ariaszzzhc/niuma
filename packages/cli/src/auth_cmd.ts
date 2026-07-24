// `niuma auth` — credential management over ~/.niuma/auth.json.
//
// Three actions:
//   login  : obtain credentials for a provider (OpenAI/ChatGPT today) via one
//            of three methods —
//              1. browser PKCE + loopback callback on OAUTH_PORT,
//              2. headless device-code flow (--device-code, or picker choice),
//              3. a pasted API key.
//            Persists via setAuth (the file stays 0600 — see @niuma/config).
//   logout : removeAuth — drops the provider's entry.
//   status : prints the entry's auth type (+ expiry for OAuth); NEVER prints
//            token material (access/refresh tokens stay on disk only).
//
// Boundary (HARD): this module owns ONLY interaction — prompts, the loopback
// HTTP server, URL printing, the device-code polling loop. Every OAuth wire
// detail (PKCE challenge, token exchange, JWT claim extraction, endpoint
// constants) lives in @niuma/config/oauth.ts and is called here verbatim. cli
// never reimplements OAuth protocol, and it NEVER imports @niuma/provider —
// login is auth-only; the adapter is wired server-side in @niuma/server.
//
// Browser opening: niuma does NOT shell out to a browser/xdg-open (codex's
// headless-friendly posture). The authorize URL is printed and the user
// opens it; a one-shot Deno.serve on 127.0.0.1:OAUTH_PORT catches the
// ?code&state redirect.

import type { AuthArgs } from "./args.ts";
import { readSecretLine, readStdinLine } from "./stdin.ts";
import {
  niumaPaths,
  getAuth,
  removeAuth,
  setAuth,
  // OAuth flow functions live in @niuma/config/oauth.ts (the oauth lane) and
  // are imported here per the binding contract — NOT reimplemented in cli.
  // They are pure/injected-fetch on the config side; this module supplies the
  // interaction (prompts, loopback server, polling loop).
  OAUTH_ISSUER,
  OAUTH_PORT,
  OAuthError,
  buildAuthorizeUrl,
  exchangeCode,
  generatePkce,
  pollDeviceAuth,
  randomState,
  requestDeviceCode,
  toOAuthAuth,
} from "@niuma/config";
import type { AuthInfo, DeviceCodeResponse, TokenResponse } from "@niuma/config";

// ===========================================================================
// runAuth — dispatch
// ===========================================================================

export const runAuth = async (args: AuthArgs): Promise<number> => {
  switch (args.action) {
    case "login":
      return await runLogin(args);
    case "logout":
      return await runLogout(args);
    case "status":
      return await runStatus(args);
  }
};

// ===========================================================================
// login
// ===========================================================================

const runLogin = async (args: AuthArgs): Promise<number> => {
  const providerId = args.providerId;
  // The OAuth flow itself is provider-id-agnostic — the same PKCE/device-code
  // exchange stores the resulting entry under whatever id the user passes, so
  // `niuma auth login chatgpt` lands the entry under "chatgpt" (paired with a
  // type="responses" provider table) and `niuma auth login openai` under
  // "openai". The method picker offers the ChatGPT browser/device flows (which
  // always hit the OpenAI issuer) plus a manual API-key path for any provider.
  const authFile = niumaPaths().authFile;

  // --device-code bypasses the picker and runs the headless device flow.
  if (args.deviceCode) {
    return await runDeviceCodeLogin(providerId, authFile);
  }

  // The interactive method picker needs a TTY on stdin.
  if (!Deno.stdin.isTerminal()) {
    console.error(
      "niuma auth login: interactive sign-in needs a TTY on stdin. " +
        "Pass --device-code for the headless flow, or run in a terminal.",
    );
    return 1;
  }

  const method = await promptMethod(providerId);
  switch (method) {
    case "browser":
      return await runBrowserLogin(providerId, authFile);
    case "device":
      return await runDeviceCodeLogin(providerId, authFile);
    case "apikey":
      return await runApiKeyLogin(providerId, authFile);
    default:
      return 1;
  }
};

const promptMethod = async (
  providerId: string,
): Promise<"browser" | "device" | "apikey" | undefined> => {
  console.error("");
  console.error(`How would you like to sign in to ${providerId}?`);
  console.error("  1. ChatGPT Pro/Plus (browser)");
  console.error("  2. ChatGPT Pro/Plus (headless device code)");
  console.error("  3. Manually enter API Key");
  Deno.stderr.writeSync(new TextEncoder().encode("choice [1-3]: "));
  const line = (await readStdinLine()) ?? "";
  const trimmed = line.trim();
  switch (trimmed) {
    case "":
    case "1":
      return "browser";
    case "2":
      return "device";
    case "3":
      return "apikey";
    default:
      console.error(`niuma: invalid choice '${trimmed}'`);
      return undefined;
  }
};

// --- method 1: browser PKCE + loopback callback -----------------------------

const SIGN_IN_HTML =
  "<!doctype html><html><body><h2>niuma: signed in</h2>" +
  "<p>You can close this tab and return to the terminal.</p></body></html>";

const runBrowserLogin = async (
  providerId: string,
  authFile: string,
): Promise<number> => {
  const { signal, cleanup } = abortOnSignal();
  try {
    const pkce = await generatePkce();
    const state = randomState();
    const url = buildAuthorizeUrl(pkce, state);

    console.error("");
    console.error("Open this URL in your browser to sign in:");
    console.error(`  ${url}`);
    console.error(
      `(niuma is listening on http://127.0.0.1:${OAUTH_PORT} for the redirect; ` +
        `if the browser cannot connect, substitute 127.0.0.1 for localhost in the URL.)`,
    );
    console.error("");

    let code: string;
    try {
      code = await waitForCallback(OAUTH_PORT, state, signal);
    } catch (err) {
      console.error(
        `niuma auth login: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }

    let tokens: TokenResponse;
    try {
      tokens = await exchangeCode(code, pkce);
    } catch (err) {
      console.error(`niuma auth login: token exchange failed — ${oauthErrMsg(err)}`);
      return 1;
    }

    await setAuth(authFile, providerId, toOAuthAuth(tokens));
    console.error(`logged in as ${providerId} (ChatGPT OAuth).`);
    return 0;
  } finally {
    cleanup();
  }
};

/**
 * One-shot loopback HTTP server: resolves with the `code` param once a
 * callback matching `expectedState` lands, then shuts down. Wrong-state / TS
 * probes get a 400 and the server keeps listening so the real sign-in still
 * lands. Aborting `signal` (Ctrl+C) tears the server down and rejects. */
const waitForCallback = (
  port: number,
  expectedState: string,
  signal: AbortSignal,
): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    let settled = false;
    const resolveOnce = (code: string) => {
      if (!settled) {
        settled = true;
        resolve(code);
      }
    };
    const rejectOnce = (err: unknown) => {
      if (!settled) {
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };

    let server: Deno.HttpServer;
    try {
      server = Deno.serve(
        // Bind without an explicit hostname so the listener is dual-stack
        // (accepts both 127.0.0.1 and ::1). OAUTH_REDIRECT_URI uses
        // "localhost", which an IPv6-first resolver (some Linux/Windows
        // getaddrinfo configs) resolves to ::1 first; a 127.0.0.1-only bind
        // would refuse that redirect and hang the login. The server is
        // one-shot, state-matched, and torn down on the first good callback,
        // so the broader bind carries no real exposure.
        { port, signal },
        (req) => {
          const u = new URL(req.url);
          const code = u.searchParams.get("code");
          const state = u.searchParams.get("state");
          if (code && state === expectedState) {
            resolveOnce(code);
            // Shut down once the response is on the wire.
            queueMicrotask(() => {
              try {
                server.shutdown();
              } catch {
                // Already shutting down.
              }
            });
            return new Response(SIGN_IN_HTML, {
              headers: { "content-type": "text/html; charset=utf-8" },
            });
          }
          // Stale/wrong callback (second tab, CSRF probe). Keep listening.
          return new Response(
            "niuma: ignored — waiting for the matching sign-in callback.",
            { status: 400 },
          );
        },
      );
    } catch (err) {
      rejectOnce(err);
      return;
    }
    // server.finished settles on graceful shutdown (code resolved first →
    // no-op) or on abort/error (reject, unless we already resolved).
    server.finished.catch((err) => rejectOnce(err));
  });

// --- method 2: headless device code ----------------------------------------

const runDeviceCodeLogin = async (
  providerId: string,
  authFile: string,
): Promise<number> => {
  const { signal, cleanup } = abortOnSignal();
  try {
    let dc: DeviceCodeResponse;
    try {
      dc = await requestDeviceCode();
    } catch (err) {
      console.error(
        `niuma auth login: device-code request failed — ${oauthErrMsg(err)}`,
      );
      return 1;
    }

    console.error("");
    console.error("To sign in, open:");
    console.error(`  ${OAUTH_ISSUER}/codex/device`);
    console.error(`and enter the code: ${dc.userCode}`);
    console.error("(waiting for approval — Ctrl+C to cancel)");
    console.error("");

    let polled: { code: string; verifier: string };
    try {
      polled = await pollDeviceAuth(dc.deviceAuthId, dc.userCode, dc.interval, {
        signal,
      });
    } catch (err) {
      console.error(
        `niuma auth login: device sign-in ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 1;
    }

    let tokens: TokenResponse;
    try {
      // Device flow exchanges against the deviceauth callback redirect (NOT
      // the loopback). The verifier comes from pollDeviceAuth; the PKCE
      // challenge is never sent to the token endpoint, so an empty challenge
      // is safe here.
      tokens = await exchangeCode(
        polled.code,
        { verifier: polled.verifier, challenge: "" },
        { redirectUri: `${OAUTH_ISSUER}/deviceauth/callback` },
      );
    } catch (err) {
      console.error(`niuma auth login: token exchange failed — ${oauthErrMsg(err)}`);
      return 1;
    }

    await setAuth(authFile, providerId, toOAuthAuth(tokens));
    console.error(`logged in as ${providerId} (ChatGPT OAuth via device code).`);
    return 0;
  } finally {
    cleanup();
  }
};

// --- method 3: manually enter an API key -----------------------------------

const runApiKeyLogin = async (
  providerId: string,
  authFile: string,
): Promise<number> => {
  // Echo is suppressed (raw-mode read) so the pasted key does not land in
  // terminal scrollback / tmux history / screen shares — the same credential
  // hygiene status/logout enforce (0600 at rest, no token material in output).
  // readSecretLine restores cooked mode in a finally, so a Ctrl+C mid-read
  // never leaves the terminal raw.
  console.error("");
  Deno.stderr.writeSync(new TextEncoder().encode(`Paste your API key for ${providerId}: `));
  const line = await readSecretLine();
  const key = (line ?? "").trim();
  if (key.length === 0) {
    console.error("niuma auth login: no key entered.");
    return 1;
  }
  await setAuth(authFile, providerId, { type: "api", key });
  console.error(`logged in as ${providerId} (API key).`);
  return 0;
};

// ===========================================================================
// logout
// ===========================================================================

const runLogout = async (args: AuthArgs): Promise<number> => {
  const providerId = args.providerId;
  const authFile = niumaPaths().authFile;
  const entry = await getAuth(authFile, providerId);
  if (entry === undefined) {
    console.error(`niuma auth logout: not logged in to '${providerId}'.`);
    return 1;
  }
  await removeAuth(authFile, providerId);
  console.error(`logged out of ${providerId}.`);
  return 0;
};

// ===========================================================================
// status
// ===========================================================================

const runStatus = async (args: AuthArgs): Promise<number> => {
  const providerId = args.providerId;
  const authFile = niumaPaths().authFile;
  const entry = await getAuth(authFile, providerId);
  if (entry === undefined) {
    console.error(`${providerId}: not logged in`);
    return 1;
  }
  printAuthEntry(providerId, entry);
  return 0;
};

/** Prints type + expiry only. Token material (access/refresh) is never
 * surfaced — it stays in the 0600 auth.json. `accountId` is a public JWT
 * claim, not a credential, so it is shown (it aids identifying which
 * ChatGPT account is active). */
const printAuthEntry = (providerId: string, entry: AuthInfo): void => {
  if (entry.type === "api") {
    console.log(`${providerId}: api key (set)`);
    return;
  }
  const remain = entry.expires - Date.now();
  const when = remain <= 0 ? "expired" : `expires in ${fmtDuration(remain)}`;
  const acct = entry.accountId !== undefined
    ? ` account ${entry.accountId}`
    : "";
  console.log(`${providerId}: chatgpt oauth${acct} (${when})`);
};

const fmtDuration = (ms: number): string => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
};

// ===========================================================================
// helpers
// ===========================================================================

/** Format an OAuth/transport error message without leaking token material. */
const oauthErrMsg = (err: unknown): string => {
  if (err instanceof OAuthError) return err.message;
  return err instanceof Error ? err.message : String(err);
};

/** Wires SIGINT (and SIGTERM on Unix) to an AbortSignal so the loopback
 * server and the device-code poll shut down cleanly on Ctrl+C. Returns a
 * cleanup fn that removes the listeners. Mirrors serve.ts's pattern. */
const abortOnSignal = (): { signal: AbortSignal; cleanup: () => void } => {
  const ac = new AbortController();
  const onInt = () => ac.abort();
  Deno.addSignalListener("SIGINT", onInt);
  let onTerm: (() => void) | undefined;
  try {
    onTerm = () => ac.abort();
    Deno.addSignalListener("SIGTERM", onTerm);
  } catch {
    // Platform without SIGTERM (Windows) — skip.
  }
  const cleanup = () => {
    try {
      Deno.removeSignalListener("SIGINT", onInt);
    } catch {
      // Already removed / never added.
    }
    if (onTerm) {
      try {
        Deno.removeSignalListener("SIGTERM", onTerm);
      } catch {
        // Already removed / never added.
      }
    }
  };
  return { signal: ac.signal, cleanup };
};
