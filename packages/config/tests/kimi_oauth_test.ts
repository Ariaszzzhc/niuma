import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  KIMI_OAUTH_CLIENT_ID,
  KIMI_OAUTH_HOST,
  makeKimiDeviceHeaders,
  OAuthError,
  pollKimiDeviceAuth,
  refreshKimiTokens,
  requestKimiDeviceAuthorization,
} from "../mod.ts";

// Network-free tests for the Kimi device-code flow (kimi_oauth.ts) — every
// call goes through an injected fetchFn; the assertions check the wire shape
// (URL, form body, X-Msh-* headers) and the poll/refresh state machine.

interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

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

const formBody = (req: CapturedRequest): Record<string, string> =>
  Object.fromEntries(new URLSearchParams(req.body));

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const DEVICE_HEADERS = makeKimiDeviceHeaders({
  version: "0.0.0-test",
  deviceId: "device-123",
  hostname: "testhost",
  os: "windows 10.0 x86_64",
});

// ----- requestKimiDeviceAuthorization ----------------------------------------

Deno.test("requestKimiDeviceAuthorization: POSTs client_id form to the device_authorization endpoint with device headers", async () => {
  const { fetchFn, requests } = capturingFetch(() =>
    jsonResponse(200, {
      device_code: "dc-1",
      user_code: "ABCD-EFGH",
      verification_uri: "https://kimi.com/device",
      verification_uri_complete: "https://kimi.com/device?code=ABCD-EFGH",
      expires_in: 600,
      interval: 7,
    })
  );
  const da = await requestKimiDeviceAuthorization({
    fetchFn,
    deviceHeaders: DEVICE_HEADERS,
  });
  assertEquals(requests.length, 1);
  const req = requests[0]!;
  assertEquals(req.url, `${KIMI_OAUTH_HOST}/api/oauth/device_authorization`);
  assertEquals(req.method, "POST");
  assertEquals(formBody(req), { client_id: KIMI_OAUTH_CLIENT_ID });
  assertEquals(req.headers.get("X-Msh-Platform"), "kimi_code_cli");
  assertEquals(req.headers.get("X-Msh-Device-Id"), "device-123");
  assertEquals(da, {
    deviceCode: "dc-1",
    userCode: "ABCD-EFGH",
    verificationUri: "https://kimi.com/device",
    verificationUriComplete: "https://kimi.com/device?code=ABCD-EFGH",
    expiresIn: 600,
    interval: 7,
  });
});

Deno.test("requestKimiDeviceAuthorization: interval defaults to 5 and expiresIn is omitted when absent", async () => {
  const { fetchFn } = capturingFetch(() =>
    jsonResponse(200, {
      device_code: "dc-1",
      user_code: "ABCD",
      verification_uri_complete: "https://kimi.com/device?code=ABCD",
    })
  );
  const da = await requestKimiDeviceAuthorization({ fetchFn });
  assertEquals(da.interval, 5);
  assertEquals("expiresIn" in da, false);
});

Deno.test("requestKimiDeviceAuthorization: missing required fields is an OAuthError", async () => {
  const { fetchFn } = capturingFetch(() =>
    jsonResponse(200, { device_code: "dc-1" })
  );
  const err = await assertRejects(
    () => requestKimiDeviceAuthorization({ fetchFn }),
    OAuthError,
  );
  assertStringIncludes(err.message, "missing");
});

Deno.test("requestKimiDeviceAuthorization: non-2xx is an OAuthError with status", async () => {
  const { fetchFn } = capturingFetch(() =>
    jsonResponse(400, { error: "invalid_client" })
  );
  const err = await assertRejects(
    () => requestKimiDeviceAuthorization({ fetchFn }),
    OAuthError,
  );
  assertEquals(err.status, 400);
});

// ----- pollKimiDeviceAuth ----------------------------------------------------

Deno.test("pollKimiDeviceAuth: authorization_pending retries, then resolves with tokens", async () => {
  let calls = 0;
  const { fetchFn, requests } = capturingFetch(() => {
    calls++;
    // First poll: pending; second: approved.
    return calls === 1
      ? jsonResponse(400, { error: "authorization_pending" })
      : jsonResponse(200, {
        access_token: "at-1",
        refresh_token: "rt-1",
        expires_in: 3600,
        token_type: "Bearer",
      });
  });
  // interval 0 clamps to the 1s minimum — one real sleep, acceptable.
  const tokens = await pollKimiDeviceAuth("dc-1", 0, { fetchFn });
  assertEquals(tokens.access_token, "at-1");
  assertEquals(tokens.refresh_token, "rt-1");
  assertEquals(tokens.expires_in, 3600);
  assertEquals(requests.length, 2);
  const req = requests[0]!;
  assertEquals(req.url, `${KIMI_OAUTH_HOST}/api/oauth/token`);
  assertEquals(formBody(req), {
    client_id: KIMI_OAUTH_CLIENT_ID,
    device_code: "dc-1",
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
});

Deno.test("pollKimiDeviceAuth: expired_token aborts the flow", async () => {
  const { fetchFn } = capturingFetch(() =>
    jsonResponse(400, { error: "expired_token" })
  );
  const err = await assertRejects(
    () => pollKimiDeviceAuth("dc-1", 0, { fetchFn }),
    OAuthError,
  );
  assertStringIncludes(err.message, "expired");
});

Deno.test("pollKimiDeviceAuth: access_denied surfaces the description", async () => {
  const { fetchFn } = capturingFetch(() =>
    jsonResponse(400, {
      error: "access_denied",
      error_description: "user declined",
    })
  );
  const err = await assertRejects(
    () => pollKimiDeviceAuth("dc-1", 0, { fetchFn }),
    OAuthError,
  );
  assertStringIncludes(err.message, "user declined");
});

Deno.test("pollKimiDeviceAuth: an aborted signal stops the poll", async () => {
  const { fetchFn } = capturingFetch(() => jsonResponse(200, {}));
  const ac = new AbortController();
  ac.abort();
  await assertRejects(
    () => pollKimiDeviceAuth("dc-1", 0, { fetchFn, signal: ac.signal }),
    OAuthError,
    "aborted",
  );
});

// ----- refreshKimiTokens -----------------------------------------------------

Deno.test("refreshKimiTokens: POSTs the refresh grant and adopts the rotated refresh token", async () => {
  const { fetchFn, requests } = capturingFetch(() =>
    jsonResponse(200, {
      access_token: "at-new",
      refresh_token: "rt-new",
      expires_in: 3600,
    })
  );
  const tokens = await refreshKimiTokens("rt-old", {
    fetchFn,
    deviceHeaders: DEVICE_HEADERS,
  });
  assertEquals(tokens.access_token, "at-new");
  assertEquals(tokens.refresh_token, "rt-new");
  const req = requests[0]!;
  assertEquals(req.url, `${KIMI_OAUTH_HOST}/api/oauth/token`);
  assertEquals(formBody(req), {
    client_id: KIMI_OAUTH_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: "rt-old",
  });
});

Deno.test("refreshKimiTokens: keeps the old refresh token when the server does not rotate", async () => {
  const { fetchFn } = capturingFetch(() =>
    jsonResponse(200, { access_token: "at-new", expires_in: 3600 })
  );
  const tokens = await refreshKimiTokens("rt-old", { fetchFn });
  assertEquals(tokens.refresh_token, "rt-old");
});

Deno.test("refreshKimiTokens: non-2xx is an OAuthError with status", async () => {
  const { fetchFn } = capturingFetch(() =>
    jsonResponse(401, { error: "invalid_grant" })
  );
  const err = await assertRejects(
    () => refreshKimiTokens("rt-old", { fetchFn }),
    OAuthError,
  );
  assertEquals(err.status, 401);
});

// ----- makeKimiDeviceHeaders --------------------------------------------------

Deno.test("makeKimiDeviceHeaders: strips non-ASCII and pins the platform", () => {
  const headers = makeKimiDeviceHeaders({
    version: "1.2.3",
    deviceId: "id-1",
    hostname: "héllo-主机",
    os: "linux 6.1 x86_64",
  });
  assertEquals(headers["X-Msh-Platform"], "kimi_code_cli");
  assertEquals(headers["X-Msh-Version"], "1.2.3");
  // Non-ASCII is removed, leaving the visible-ASCII remainder.
  assertEquals(headers["X-Msh-Device-Name"], "hllo-");
  assertEquals(headers["X-Msh-Device-Model"], "linux 6.1 x86_64");
  assertEquals(headers["X-Msh-Device-Id"], "id-1");
});
