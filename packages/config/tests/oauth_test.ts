import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { encodeBase64Url } from "@std/encoding";
import {
  buildAuthorizeUrl,
  exchangeCode,
  extractAccountId,
  generatePkce,
  OAUTH_CLIENT_ID,
  OAUTH_ISSUER,
  OAUTH_REDIRECT_URI,
  OAuthError,
  parseJwtClaims,
  pollDeviceAuth,
  randomState,
  refreshTokens,
  requestDeviceCode,
  toOAuthAuth,
} from "../mod.ts";
import type { PkceCodes, TokenResponse } from "../mod.ts";

// ----- helpers ---------------------------------------------------------------

const b64urlJson = (obj: unknown): string =>
  encodeBase64Url(new TextEncoder().encode(JSON.stringify(obj)));

/** Assemble a three-part JWT (signature is irrelevant — claims are never
 * verified, only decoded, and only ever received over TLS from the issuer). */
const makeJwt = (payload: Record<string, unknown>): string =>
  `${b64urlJson({ alg: "none" })}.${b64urlJson(payload)}.sig`;

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

/** Builds an injectable fetchFn that records every call and dispatches via the
 * handler. Request body is captured as text (the OAuth calls are all
 * form-urlencoded or JSON strings). */
const capturingFetch = (
  handler: (req: CapturedRequest) => Response | Promise<Response>,
): { fetchFn: typeof fetch; requests: CapturedRequest[] } => {
  const requests: CapturedRequest[] = [];
  const fetchFn = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const req: CapturedRequest = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    };
    requests.push(req);
    return await handler(req);
  }) as typeof fetch;
  return { fetchFn, requests };
};

/** Parse a form-urlencoded request body into a plain object. */
const formBody = (req: CapturedRequest): Record<string, string> =>
  Object.fromEntries(new URLSearchParams(req.body));

const withFixedNow = async <T>(ms: number, fn: () => Promise<T> | T): Promise<T> => {
  const real = Date.now;
  Date.now = () => ms;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
};

// ----- PKCE + state ---------------------------------------------------------

Deno.test("generatePkce: verifier is 43 unreserved chars, challenge is S256 base64url", async () => {
  const { verifier, challenge } = await generatePkce();
  assertEquals(verifier.length, 43);
  // Verifier draws only from the RFC 7636 unreserved set.
  assertStringIncludes(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~",
    verifier[0]!,
  );
  assertEquals(/^[A-Za-z0-9-._~]+$/.test(verifier), true);
  // Challenge has no padding and equals base64url(SHA-256(verifier)).
  assertEquals(challenge.includes("="), false);
  const expected = encodeBase64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
  assertEquals(challenge, expected);
});

Deno.test("generatePkce: two calls produce different verifiers", async () => {
  const a = await generatePkce();
  const b = await generatePkce();
  assertEquals(a.verifier === b.verifier, false);
});

Deno.test("randomState: base64url, no padding, fresh each call", () => {
  const s = randomState();
  assertEquals(s.includes("="), false);
  assertEquals(s.length > 0, true);
  assertEquals(randomState() === s, false);
});

// ----- authorize URL --------------------------------------------------------

Deno.test("buildAuthorizeUrl: carries every required param with originator=niuma", async () => {
  const pkce = await generatePkce();
  const state = "state-123";
  const url = buildAuthorizeUrl(pkce, state);
  const parsed = new URL(url);
  assertEquals(`${parsed.origin}${parsed.pathname}`, `${OAUTH_ISSUER}/oauth/authorize`);
  const params = parsed.searchParams;
  assertEquals(params.get("response_type"), "code");
  assertEquals(params.get("client_id"), OAUTH_CLIENT_ID);
  assertEquals(params.get("redirect_uri"), OAUTH_REDIRECT_URI);
  assertEquals(params.get("scope"), "openid profile email offline_access");
  assertEquals(params.get("code_challenge"), pkce.challenge);
  assertEquals(params.get("code_challenge_method"), "S256");
  assertEquals(params.get("id_token_add_organizations"), "true");
  assertEquals(params.get("codex_cli_simplified_flow"), "true");
  assertEquals(params.get("state"), state);
  assertEquals(params.get("originator"), "niuma");
});

// ----- exchangeCode ---------------------------------------------------------

const stubPkce: PkceCodes = { verifier: "v".repeat(43), challenge: "c" };

Deno.test("exchangeCode: posts form-encoded grant and parses the response", async () => {
  const tokenBody: TokenResponse = {
    id_token: "idt",
    access_token: "atk",
    refresh_token: "rtk",
    expires_in: 3600,
  };
  const { fetchFn, requests } = capturingFetch(() => jsonResponse(200, tokenBody));
  const tokens = await exchangeCode("the-code", stubPkce, { fetchFn });
  assertEquals(tokens, tokenBody);

  assertEquals(requests.length, 1);
  const req = requests[0]!;
  assertEquals(req.url, `${OAUTH_ISSUER}/oauth/token`);
  assertEquals(req.method, "POST");
  assertEquals(req.headers.get("Content-Type"), "application/x-www-form-urlencoded");
  assertEquals(formBody(req), {
    grant_type: "authorization_code",
    code: "the-code",
    redirect_uri: OAUTH_REDIRECT_URI,
    client_id: OAUTH_CLIENT_ID,
    code_verifier: stubPkce.verifier,
  });
});

Deno.test("exchangeCode: redirectUri override is sent through (device flow)", async () => {
  const { fetchFn, requests } = capturingFetch(() =>
    jsonResponse(200, { access_token: "a", refresh_token: "r" })
  );
  await exchangeCode("c", stubPkce, {
    fetchFn,
    redirectUri: `${OAUTH_ISSUER}/deviceauth/callback`,
  });
  assertEquals(
    formBody(requests[0]!).redirect_uri,
    `${OAUTH_ISSUER}/deviceauth/callback`,
  );
});

Deno.test("exchangeCode: non-2xx throws OAuthError with status and body", async () => {
  const { fetchFn } = capturingFetch(() =>
    jsonResponse(400, { error: "invalid_grant" })
  );
  const err = await assertRejects(
    () => exchangeCode("c", stubPkce, { fetchFn }),
    OAuthError,
  );
  assertEquals(err.status, 400);
  assertStringIncludes(err.message, "400");
  assertStringIncludes(err.message, "invalid_grant");
});

Deno.test("exchangeCode: response missing tokens throws OAuthError", async () => {
  const { fetchFn } = capturingFetch(() =>
    jsonResponse(200, { access_token: "a" })
  );
  await assertRejects(
    () => exchangeCode("c", stubPkce, { fetchFn }),
    OAuthError,
    "missing access_token or refresh_token",
  );
});

// ----- refreshTokens --------------------------------------------------------

Deno.test("refreshTokens: posts refresh grant and returns rotated tokens", async () => {
  const { fetchFn, requests } = capturingFetch(() =>
    jsonResponse(200, {
      access_token: "new-a",
      refresh_token: "new-r",
      expires_in: 1800,
    })
  );
  const tokens = await refreshTokens("old-r", { fetchFn });
  assertEquals(tokens, { access_token: "new-a", refresh_token: "new-r", expires_in: 1800 });
  assertEquals(formBody(requests[0]!), {
    grant_type: "refresh_token",
    refresh_token: "old-r",
    client_id: OAUTH_CLIENT_ID,
  });
});

Deno.test("refreshTokens: keeps the input refresh token when the issuer omits it", async () => {
  // No rotation: the response carries no refresh_token.
  const { fetchFn } = capturingFetch(() =>
    jsonResponse(200, { access_token: "a", expires_in: 100 })
  );
  const tokens = await refreshTokens("kept-r", { fetchFn });
  assertEquals(tokens.refresh_token, "kept-r");
  assertEquals(tokens.access_token, "a");
  assertEquals(tokens.expires_in, 100);
});

Deno.test("refreshTokens: non-2xx throws OAuthError with status", async () => {
  const { fetchFn } = capturingFetch(() => jsonResponse(401, { error: "invalid_grant" }));
  const err = await assertRejects(() => refreshTokens("r", { fetchFn }), OAuthError);
  assertEquals(err.status, 401);
});

Deno.test("refreshTokens: response missing access_token throws OAuthError", async () => {
  const { fetchFn } = capturingFetch(() => jsonResponse(200, { refresh_token: "r" }));
  await assertRejects(
    () => refreshTokens("r", { fetchFn }),
    OAuthError,
    "missing access_token",
  );
});

// ----- requestDeviceCode ----------------------------------------------------

Deno.test("requestDeviceCode: parses device_auth_id/user_code and string interval", async () => {
  const { fetchFn, requests } = capturingFetch(() =>
    jsonResponse(200, {
      device_auth_id: "daid-1",
      user_code: "USER-CODE",
      interval: "5",
    })
  );
  const dc = await requestDeviceCode({ fetchFn });
  assertEquals(dc, { deviceAuthId: "daid-1", userCode: "USER-CODE", interval: 5 });
  assertEquals(requests[0]!.url, `${OAUTH_ISSUER}/api/accounts/deviceauth/usercode`);
  assertEquals(
    JSON.parse(requests[0]!.body),
    { client_id: OAUTH_CLIENT_ID },
  );
});

Deno.test("requestDeviceCode: accepts a numeric interval too", async () => {
  const { fetchFn } = capturingFetch(() =>
    jsonResponse(200, { device_auth_id: "d", user_code: "c", interval: 10 })
  );
  assertEquals((await requestDeviceCode({ fetchFn })).interval, 10);
});

Deno.test("requestDeviceCode: non-2xx throws OAuthError", async () => {
  const { fetchFn } = capturingFetch(() => jsonResponse(404, "not enabled"));
  const err = await assertRejects(() => requestDeviceCode({ fetchFn }), OAuthError);
  assertEquals(err.status, 404);
});

Deno.test("requestDeviceCode: missing fields throws OAuthError", async () => {
  const { fetchFn } = capturingFetch(() =>
    jsonResponse(200, { device_auth_id: "d" })
  );
  await assertRejects(
    () => requestDeviceCode({ fetchFn }),
    OAuthError,
    "missing device_auth_id/user_code/interval",
  );
});

// ----- pollDeviceAuth -------------------------------------------------------

Deno.test("pollDeviceAuth: 403 then 404 (pending) then 200 returns code+verifier", async () => {
  const responses = [
    jsonResponse(403, ""),
    jsonResponse(404, ""),
    jsonResponse(200, { authorization_code: "ac", code_verifier: "cv" }),
  ];
  let i = 0;
  const { fetchFn, requests } = capturingFetch(() => responses[i++]!);
  // Tiny interval so the retry sleep is negligible.
  const result = await pollDeviceAuth("daid", "uc", 0, { fetchFn });
  assertEquals(result, { code: "ac", verifier: "cv" });
  assertEquals(requests.length, 3);
  for (const req of requests) {
    assertEquals(req.url, `${OAUTH_ISSUER}/api/accounts/deviceauth/token`);
    assertEquals(JSON.parse(req.body), { device_auth_id: "daid", user_code: "uc" });
  }
});

Deno.test("pollDeviceAuth: a terminal error status throws OAuthError", async () => {
  const { fetchFn } = capturingFetch(() => jsonResponse(500, "boom"));
  const err = await assertRejects(
    () => pollDeviceAuth("d", "u", 0, { fetchFn }),
    OAuthError,
  );
  assertEquals(err.status, 500);
});

Deno.test("pollDeviceAuth: success response missing fields throws OAuthError", async () => {
  const { fetchFn } = capturingFetch(() => jsonResponse(200, { authorization_code: "x" }));
  await assertRejects(
    () => pollDeviceAuth("d", "u", 0, { fetchFn }),
    OAuthError,
    "missing authorization_code/code_verifier",
  );
});

// ----- parseJwtClaims + extractAccountId ------------------------------------

Deno.test("parseJwtClaims: returns undefined for malformed tokens", () => {
  assertEquals(parseJwtClaims("not-a-jwt"), undefined);
  assertEquals(parseJwtClaims("only.two"), undefined);
  assertEquals(parseJwtClaims("a.b.c.d"), undefined);
});

Deno.test("parseJwtClaims: extracts the typed subset and drops unrelated fields", () => {
  const claims = parseJwtClaims(
    makeJwt({
      chatgpt_account_id: "flat",
      email: "u@example.com",
      organizations: [{ id: "org-1" }, { id: "org-2" }],
      "https://api.openai.com/auth": { chatgpt_account_id: "ns", chatgpt_plan_type: "plus" },
      unrelated: "drop",
    }),
  )!;
  assertEquals(claims.chatgpt_account_id, "flat");
  assertEquals(claims.organizations, [{ id: "org-1" }, { id: "org-2" }]);
  assertEquals(claims["https://api.openai.com/auth"], { chatgpt_account_id: "ns" });
  // No leak of unrelated/email/plan-type into the typed object.
  assertEquals(
    "unrelated" in (claims as Record<string, unknown>),
    false,
  );
});

Deno.test("extractAccountId: namespaced claim wins over flat claim and organizations", () => {
  const idToken = makeJwt({
    chatgpt_account_id: "flat",
    organizations: [{ id: "org" }],
    "https://api.openai.com/auth": { chatgpt_account_id: "ns" },
  });
  assertEquals(extractAccountId({ access_token: "a", refresh_token: "r", id_token: idToken }), "ns");
});

Deno.test("extractAccountId: flat claim used when namespaced is absent", () => {
  const idToken = makeJwt({ chatgpt_account_id: "flat", organizations: [{ id: "org" }] });
  assertEquals(extractAccountId({ access_token: "a", refresh_token: "r", id_token: idToken }), "flat");
});

Deno.test("extractAccountId: first organization id used when no account claim is present", () => {
  const idToken = makeJwt({ organizations: [{ id: "org-a" }, { id: "org-b" }] });
  assertEquals(extractAccountId({ access_token: "a", refresh_token: "r", id_token: idToken }), "org-a");
});

Deno.test("extractAccountId: falls back to the access_token when id_token has no account", () => {
  const idToken = makeJwt({ email: "u@example.com" });
  const accessToken = makeJwt({ chatgpt_account_id: "from-access" });
  assertEquals(
    extractAccountId({
      access_token: accessToken,
      refresh_token: "r",
      id_token: idToken,
    }),
    "from-access",
  );
});

Deno.test("extractAccountId: returns undefined when neither token carries an account", () => {
  const idToken = makeJwt({ email: "u@example.com" });
  assertEquals(
    extractAccountId({ access_token: idToken, refresh_token: "r" }),
    undefined,
  );
});

// ----- toOAuthAuth ----------------------------------------------------------

Deno.test("toOAuthAuth: expires = now + expires_in*1000, accountId propagated", async () => {
  await withFixedNow(1_700_000_000_000, () => {
    const idToken = makeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } });
    const auth = toOAuthAuth({
      access_token: "a",
      refresh_token: "r",
      id_token: idToken,
      expires_in: 3600,
    });
    assertEquals(auth, {
      type: "oauth",
      refresh: "r",
      access: "a",
      expires: 1_700_000_000_000 + 3600 * 1000,
      accountId: "acct-1",
    });
  });
});

Deno.test("toOAuthAuth: without expires_in, falls back to the access_token JWT exp", async () => {
  await withFixedNow(1_700_000_000_000, () => {
    // exp is in seconds; toOAuthAuth multiplies to ms. now() is NOT used here.
    const accessToken = makeJwt({ exp: 1_700_000_100 });
    const auth = toOAuthAuth({ access_token: accessToken, refresh_token: "r" });
    assertEquals(auth.expires, 1_700_000_100 * 1000);
    // No account claim anywhere → accountId omitted entirely.
    assertEquals("accountId" in auth, false);
  });
});

Deno.test("toOAuthAuth: without expires_in or exp, expires = 0 (always-stale)", () => {
  const auth = toOAuthAuth({ access_token: "not-a-jwt", refresh_token: "r" });
  assertEquals(auth.expires, 0);
});

// ----- edge cases (parseJwtClaims + extract robustness) ---------------------

Deno.test("parseJwtClaims: empty payload yields an empty claims object", () => {
  const claims = parseJwtClaims(makeJwt({}))!;
  assertEquals(claims, {});
  // No account claim anywhere -> accountId is omitted.
  assertEquals("chatgpt_account_id" in claims, false);
  assertEquals("organizations" in claims, false);
  assertEquals("https://api.openai.com/auth" in claims, false);
});

Deno.test("parseJwtClaims: non-string fields on the auth namespace are dropped", () => {
  // A malformed issuer might send chatgpt_account_id as a number; the parser
  // must ignore it rather than propagate a wrong type downstream.
  const claims = parseJwtClaims(
    makeJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: 42,
        unrelated: "drop",
      },
    }),
  )!;
  assertEquals(claims["https://api.openai.com/auth"], undefined);
});

Deno.test("parseJwtClaims: filters non-object entries from organizations", () => {
  const claims = parseJwtClaims(
    makeJwt({
      organizations: [
        null,
        { id: "org-1" },
        "string-not-object",
        { id: 42 }, // wrong id type
        { id: "org-2" },
      ],
    }),
  )!;
  assertEquals(claims.organizations, [{ id: "org-1" }, { id: "org-2" }]);
});

Deno.test("parseJwtClaims: non-JSON payload returns undefined", () => {
  // payload: segment is base64url of "{not json" -> invalid JSON.
  const notJson = encodeBase64Url(new TextEncoder().encode("{not json"));
  const token = `aaa.${notJson}.sig`;
  assertEquals(parseJwtClaims(token), undefined);
});

Deno.test("parseJwtClaims: payload decodes to a non-object returns undefined", () => {
  const arr = encodeBase64Url(new TextEncoder().encode("[1,2,3]"));
  assertEquals(parseJwtClaims(`aaa.${arr}.sig`), undefined);
  const str = encodeBase64Url(new TextEncoder().encode("hello"));
  assertEquals(parseJwtClaims(`aaa.${str}.sig`), undefined);
});

Deno.test("extractAccountId: organizations with no extractable id is treated as absent", () => {
  // All organizations entries lack a string id -> the chain falls through and
  // (since no other claim is present) extractAccountId returns undefined.
  const idToken = makeJwt({
    organizations: [{ id: 42 }, null, { name: "no-id" }],
  });
  assertEquals(
    extractAccountId({ access_token: "a", refresh_token: "r", id_token: idToken }),
    undefined,
  );
});

Deno.test("extractAccountId: id_token primary, access_token fallback even when id_token is empty", () => {
  // Tokens can be empty (e.g. id_token undefined and access_token not a JWT).
  // The fallback walker must handle undefined id_token without crashing.
  const accessToken = makeJwt({ chatgpt_account_id: "from-access" });
  assertEquals(
    extractAccountId({ access_token: accessToken, refresh_token: "r" }),
    "from-access",
  );
});

// ----- toOAuthAuth expiry math edge cases -----------------------------------

Deno.test("toOAuthAuth: expires_in = 0 is allowed (already-stale immediate refresh)", async () => {
  await withFixedNow(1_700_000_000_000, () => {
    const auth = toOAuthAuth({
      access_token: "a",
      refresh_token: "r",
      expires_in: 0,
    });
    assertEquals(auth.expires, 1_700_000_000_000);
  });
});

Deno.test("toOAuthAuth: JWT exp non-numeric is ignored, falls through to 0", () => {
  // exp is a string in the payload -> jwtExpMs returns undefined -> falls to
  // the 0 default. The user only stays signed in for the next refresh cycle.
  const accessToken = makeJwt({ exp: "soon" });
  const auth = toOAuthAuth({ access_token: accessToken, refresh_token: "r" });
  assertEquals(auth.expires, 0);
});

Deno.test("toOAuthAuth: accountId omitted even when id_token is set but has no claim", () => {
  const idToken = makeJwt({ email: "u@example.com" });
  const auth = toOAuthAuth({
    access_token: "a",
    refresh_token: "r",
    id_token: idToken,
    expires_in: 3600,
  });
  assertEquals("accountId" in auth, false);
});

// ----- PKCE / state shape edge cases ----------------------------------------

Deno.test("randomState: encoded length is 22 (16 bytes base64url, no padding)", () => {
  // 16 bytes -> 16 * 4/3 = ceil(21.33) -> 22 base64url chars (no padding).
  const s = randomState();
  assertEquals(s.length, 22);
  assertEquals(s.includes("="), false);
  assertEquals(/^[A-Za-z0-9_-]+$/.test(s), true);
});

Deno.test("generatePkce: every generated verifier parses as a valid S256 challenge", async () => {
  // Round-trip 5 calls: the verifier -> challenge -> S256(verifier) -> equal.
  for (let i = 0; i < 5; i++) {
    const { verifier, challenge } = await generatePkce();
    const expected = encodeBase64Url(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
      ),
    );
    assertEquals(challenge, expected);
  }
});

// ----- exchange/refresh body-encoded edge cases -----------------------------

Deno.test("exchangeCode: 2xx response with non-JSON body throws OAuthError", async () => {
  // The non-JSON branch only fires on 2xx (when the JSON parser is actually
  // invoked). A non-2xx with a non-JSON body still throws but with the
  // generic "token exchange failed" message.
  const { fetchFn } = capturingFetch(() =>
    new Response("<html>error</html>", { status: 200 })
  );
  const err = await assertRejects(
    () => exchangeCode("c", stubPkce, { fetchFn }),
    OAuthError,
  );
  assertEquals(err.status, 200);
  assertStringIncludes(err.message, "non-JSON");
});

Deno.test("exchangeCode: 2xx non-object JSON body throws OAuthError", async () => {
  const { fetchFn } = capturingFetch(() => jsonResponse(200, ["not", "object"]));
  const err = await assertRejects(
    () => exchangeCode("c", stubPkce, { fetchFn }),
    OAuthError,
  );
  assertEquals(err.status, 200);
  assertStringIncludes(err.message, "non-object");
});

Deno.test("refreshTokens: id_token is propagated when the issuer returns it", async () => {
  const { fetchFn } = capturingFetch(() =>
    jsonResponse(200, {
      access_token: "a",
      refresh_token: "r",
      id_token: "idt",
      expires_in: 60,
    })
  );
  const tokens = await refreshTokens("old-r", { fetchFn });
  assertEquals(tokens.id_token, "idt");
  assertEquals(tokens.expires_in, 60);
  assertEquals(tokens.access_token, "a");
  assertEquals(tokens.refresh_token, "r");
});

Deno.test("refreshTokens: 2xx response with non-JSON body throws OAuthError", async () => {
  const { fetchFn } = capturingFetch(() =>
    new Response("plain text", { status: 200 })
  );
  const err = await assertRejects(
    () => refreshTokens("r", { fetchFn }),
    OAuthError,
  );
  assertEquals(err.status, 200);
  assertStringIncludes(err.message, "non-JSON");
});

Deno.test("refreshTokens: 2xx non-object JSON body throws OAuthError", async () => {
  const { fetchFn } = capturingFetch(() => jsonResponse(200, "string"));
  const err = await assertRejects(
    () => refreshTokens("r", { fetchFn }),
    OAuthError,
  );
  assertEquals(err.status, 200);
  assertStringIncludes(err.message, "non-object");
});

// ----- requestDeviceCode edge cases -----------------------------------------

Deno.test("requestDeviceCode: interval string with whitespace is parsed", async () => {
  // The codex wire sometimes tacks leading/trailing whitespace onto the
  // interval string; the parser must tolerate it.
  const { fetchFn } = capturingFetch(() =>
    jsonResponse(200, {
      device_auth_id: "d",
      user_code: "u",
      interval: "  7  ",
    })
  );
  assertEquals((await requestDeviceCode({ fetchFn })).interval, 7);
});

Deno.test("requestDeviceCode: malformed interval (non-numeric string) throws", async () => {
  const { fetchFn } = capturingFetch(() =>
    jsonResponse(200, {
      device_auth_id: "d",
      user_code: "u",
      interval: "forever",
    })
  );
  await assertRejects(
    () => requestDeviceCode({ fetchFn }),
    OAuthError,
    "missing device_auth_id/user_code/interval",
  );
});

Deno.test("requestDeviceCode: accepts user_code alias usercode", async () => {
  // Some issuer variants emit `usercode` instead of `user_code`.
  const { fetchFn } = capturingFetch(() =>
    jsonResponse(200, {
      device_auth_id: "d",
      usercode: "U-9",
      interval: 5,
    })
  );
  assertEquals((await requestDeviceCode({ fetchFn })).userCode, "U-9");
});

Deno.test("requestDeviceCode: non-object JSON body throws OAuthError", async () => {
  const { fetchFn } = capturingFetch(() => jsonResponse(200, ["not", "object"]));
  await assertRejects(() => requestDeviceCode({ fetchFn }), OAuthError);
});

// ----- pollDeviceAuth edge cases --------------------------------------------

Deno.test("pollDeviceAuth: a pre-aborted signal short-circuits to OAuthError", async () => {
  const controller = new AbortController();
  controller.abort();
  const { fetchFn } = capturingFetch(() =>
    jsonResponse(200, { authorization_code: "x", code_verifier: "y" })
  );
  await assertRejects(
    () => pollDeviceAuth("d", "u", 0, { fetchFn, signal: controller.signal }),
    OAuthError,
    "aborted",
  );
});

Deno.test("pollDeviceAuth: 200 response with malformed JSON throws OAuthError", async () => {
  const { fetchFn } = capturingFetch(() =>
    new Response("data: {not json", { status: 200 })
  );
  await assertRejects(
    () => pollDeviceAuth("d", "u", 0, { fetchFn }),
    OAuthError,
    "not JSON",
  );
});

Deno.test("pollDeviceAuth: 200 response with non-object JSON throws OAuthError", async () => {
  const { fetchFn } = capturingFetch(() =>
    jsonResponse(200, ["not", "object"])
  );
  await assertRejects(
    () => pollDeviceAuth("d", "u", 0, { fetchFn }),
    OAuthError,
    "not an object",
  );
});
