import { assertRejects, assertStringIncludes, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { Effect, Stream } from "effect";
import { ConfigError, parseConfig, setAuth } from "@niuma/config";
import { buildProvider } from "../src/bootstrap.ts";

// Exercises the server-side wiring (contract §6) that makeProviderFromConfig
// delegates to: the three-way auth lookup (api / oauth / {env:VAR}) and the
// dispatch to makeResponsesAdapter for type="responses" providers. The auth
// path is injected via buildProvider (the auth-path-injectable core) so the
// tests never touch NIUMA_DATA_DIR or ~/.niuma. Each case drives the built
// adapter through one stream and asserts on the captured fetch (URL + auth
// header), proving the wiring lands the right adapter with the right
// credentials rather than just that it type-checks.

const withTempAuth = async (
  fn: (authPath: string) => Promise<void>,
): Promise<void> => {
  const dir = await Deno.makeTempDir({ prefix: "niuma_provider_cfg_" });
  try {
    await fn(join(dir, "auth.json"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

const responsesConfig = parseConfig(`
  model = "openai/gpt-5"
  [provider.openai]
  type = "responses"
  [provider.openai.models.gpt-5]
  context_window = 400000
  max_output = 128000
`);

const openaiChatConfig = parseConfig(`
  model = "openai/gpt-5"
  [provider.openai]
  type = "openai"
  base_url = "https://api.openai.com/v1"
  [provider.openai.models.gpt-5]
  context_window = 128000
  max_output = 8192
`);

/** Stream one request through the built adapter and resolve with the captured
 * URL + authorization header of the (first) POST the adapter issues. */
const capturePost = async (
  authPath: string,
  config: typeof responsesConfig,
  fetchImpl: typeof fetch,
): Promise<{ url: string; auth: string }> => {
  const adapter = await buildProvider(config, authPath);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  let url = "";
  let auth = "";
  try {
    // Re-stub after buildProvider is constructed (construction does no I/O for
    // the responses adapter, but capture here so the stream's POST is seen).
    globalThis.fetch = (input, init) => {
      url = String(input);
      auth = new Headers((init as RequestInit)?.headers).get("authorization") ??
        "";
      return fetchImpl(input, init);
    };
    await Effect.runPromise(
      Stream.runCollect(
        adapter.stream({ model: "gpt-5", messages: [], tools: [] }),
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  return { url, auth };
};

const sseDone = (): Response =>
  new Response("data: [DONE]\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

// =============================================================================
// responses + apiKey
// =============================================================================

Deno.test({
  name: "makeProviderFromConfig: type=responses + api key dispatches to the Responses apiKey lane",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withTempAuth(async (authPath) => {
      await setAuth(authPath, "openai", { type: "api", key: "test-key" });
      const { url, auth } = await capturePost(authPath, responsesConfig, () =>
        Promise.resolve(sseDone())
      );
      assertEquals(url, "https://api.openai.com/v1/responses");
      assertEquals(auth, "Bearer test-key");
    });
  },
});

// =============================================================================
// responses + oauth (refresh + codex rewrite)
// =============================================================================

Deno.test({
  name: "makeProviderFromConfig: type=responses + oauth entry refreshes then posts to the codex backend",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withTempAuth(async (authPath) => {
      // expires:0 = always-stale sentinel, so getAccessToken issues a refresh
      // before the first POST (exercises the proactive-skew + single-flight
      // path in oauth_source.ts end-to-end through the adapter).
      await setAuth(authPath, "openai", {
        type: "oauth",
        refresh: "rt-old",
        access: "at-stale",
        expires: 0,
      });

      let refreshCalls = 0;
      let codexUrl = "";
      let codexAuth = "";
      const { CODEX_BACKEND_URL } = await import("@niuma/provider");
      const fetchImpl: typeof fetch = (input, init) => {
        const url = String(input);
        if (url.endsWith("/oauth/token")) {
          refreshCalls++;
          return Promise.resolve(
            new Response(
              JSON.stringify({
                access_token: "at-fresh",
                refresh_token: "rt-new",
                expires_in: 3600,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }
        codexUrl = url;
        codexAuth = new Headers((init as RequestInit)?.headers)
          .get("authorization") ?? "";
        return Promise.resolve(sseDone());
      };

      const { url, auth } = await capturePost(authPath, responsesConfig, fetchImpl);
      // The captured POST is the codex-backend one (the only non-refresh POST).
      assertEquals(url, CODEX_BACKEND_URL);
      assertEquals(codexUrl, CODEX_BACKEND_URL);
      // The refreshed access token is what the codex POST authorizes with
      // (NOT the stale "at-stale"), proving the refresh landed in the cache.
      assertEquals(auth, "Bearer at-fresh");
      assertEquals(codexAuth, "Bearer at-fresh");
      // Single-flight: exactly one refresh POST for the whole stream.
      assertEquals(refreshCalls, 1);
    });
  },
});

// =============================================================================
// oauth + non-responses provider → ConfigError
// =============================================================================

Deno.test({
  name: "makeProviderFromConfig: oauth entry paired with a non-responses provider type is a ConfigError",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withTempAuth(async (authPath) => {
      await setAuth(authPath, "openai", {
        type: "oauth",
        refresh: "rt",
        access: "at",
        expires: 1_700_000_000_000,
      });
      // type="openai" (chat-completions) has no ChatGPT-subscription path, so
      // an oauth entry is a configuration error caught at dispatch — not
      // silently dropped (which would yield "no credentials").
      const err = await assertRejects(
        () => buildProvider(openaiChatConfig, authPath),
        ConfigError,
      );
      assertStringIncludes(err.message, "only apply to type");
      assertStringIncludes(err.message, '"responses"');
    });
  },
});

// =============================================================================
// openai (chat-completions) + api key is unchanged by the new dispatch
// =============================================================================

Deno.test({
  name: "makeProviderFromConfig: type=openai + api key still posts to {baseUrl}/chat/completions (unchanged arm)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withTempAuth(async (authPath) => {
      await setAuth(authPath, "openai", { type: "api", key: "sk-cc" });
      const { url, auth } = await capturePost(authPath, openaiChatConfig, () =>
        Promise.resolve(sseDone())
      );
      assertEquals(url, "https://api.openai.com/v1/chat/completions");
      assertEquals(auth, "Bearer sk-cc");
    });
  },
});
