import { assertEquals } from "@std/assert";
import { Effect, Stream } from "effect";
import { makeOpenAIAdapter } from "../src/openai.ts";
import type { OAuthTokenSource } from "../src/responses.ts";
import type { ChatRequest } from "../src/domain.ts";

// OAuth lane of the chat-completions adapter: the token comes from the
// injected OAuthTokenSource per request, and a 401 triggers exactly one
// invalidateAndRefresh + retry (the same bounded ladder as responses.ts).
// Network-free: global fetch is stubbed.

const sseDone = (): Response =>
  new Response("data: [DONE]\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

const REQ: ChatRequest = { model: "test-model", messages: [], tools: [] };

const withStubbedFetch = async (
  fetchImpl: typeof fetch,
  fn: () => Promise<void>,
): Promise<void> => {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
};

Deno.test({
  name:
    "openai adapter oauth: posts to {baseUrl}/chat/completions with the source's Bearer token",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const tokenSource: OAuthTokenSource = {
      getAccessToken: () => Effect.succeed({ accessToken: "at-1" }),
      invalidateAndRefresh: () => Effect.succeed({ accessToken: "at-2" }),
    };
    const adapter = makeOpenAIAdapter({
      baseUrl: "https://kimi.example/coding/v1",
      defaultModel: "test-model",
      auth: { kind: "oauth", tokenSource },
    });
    let url = "";
    let auth = "";
    await withStubbedFetch((input, init) => {
      url = String(input);
      auth = new Headers((init as RequestInit)?.headers).get("authorization") ??
        "";
      return Promise.resolve(sseDone());
    }, async () => {
      await Effect.runPromise(Stream.runCollect(adapter.stream(REQ)));
    });
    assertEquals(url, "https://kimi.example/coding/v1/chat/completions");
    assertEquals(auth, "Bearer at-1");
  },
});

Deno.test({
  name:
    "openai adapter oauth: a 401 triggers exactly one invalidateAndRefresh + retry",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    let invalidated = 0;
    const tokenSource: OAuthTokenSource = {
      getAccessToken: () => Effect.succeed({ accessToken: "at-stale" }),
      invalidateAndRefresh: () => {
        invalidated++;
        return Effect.succeed({ accessToken: "at-fresh" });
      },
    };
    const adapter = makeOpenAIAdapter({
      baseUrl: "https://kimi.example/coding/v1",
      defaultModel: "test-model",
      auth: { kind: "oauth", tokenSource },
    });
    const auths: string[] = [];
    await withStubbedFetch((_input, init) => {
      const auth = new Headers((init as RequestInit)?.headers)
        .get("authorization") ?? "";
      auths.push(auth);
      // First POST is rejected with a 401 (→ AuthFailed via classifyResponse);
      // the retry with the refreshed token succeeds.
      return Promise.resolve(
        auths.length === 1
          ? new Response(JSON.stringify({ error: "expired" }), { status: 401 })
          : sseDone(),
      );
    }, async () => {
      await Effect.runPromise(Stream.runCollect(adapter.stream(REQ)));
    });
    assertEquals(auths, ["Bearer at-stale", "Bearer at-fresh"]);
    assertEquals(invalidated, 1);
  },
});
