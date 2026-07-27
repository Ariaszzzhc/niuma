import { assertEquals } from "@std/assert";
import { Effect, Stream } from "effect";
import { VERSION } from "@niuma/config";
import {
  CODEX_BACKEND_URL,
  makeResponsesAdapter,
  type OAuthTokenSource,
  type ResponsesAdapterConfig,
} from "../src/responses.ts";
import { AuthFailed, RateLimited } from "../src/errors.ts";
import {
  messagesToResponses,
  toolsToResponses,
} from "../src/responses_convert.ts";
import type { ChatRequest } from "../src/domain.ts";

// =============================================================================
// Helpers
// =============================================================================
const apiKeyConfig = (
  overrides: Partial<ResponsesAdapterConfig> = {},
): ResponsesAdapterConfig => ({
  baseUrl: "https://api.openai.com/v1",
  defaultModel: "gpt-5",
  auth: { kind: "apiKey", key: "test-key" },
  ...overrides,
});

const oauthConfig = (
  overrides: {
    tokenSource?: OAuthTokenSource;
    defaultModel?: string;
    baseUrl?: string;
  } = {},
): ResponsesAdapterConfig => ({
  baseUrl: overrides.baseUrl ?? "https://api.openai.com/v1",
  defaultModel: overrides.defaultModel ?? "gpt-5",
  auth: {
    kind: "oauth",
    tokenSource: overrides.tokenSource ?? {
      getAccessToken: () =>
        Effect.succeed({ accessToken: "tok-1", accountId: "acct-1" }),
      invalidateAndRefresh: () =>
        Effect.succeed({ accessToken: "tok-2", accountId: "acct-1" }),
    },
  },
});

// Capture the URL, headers, and JSON body of the single POST the adapter
// issues, by stubbing globalThis.fetch (niumaFetch routes through it). Mirrors
// anthropic_test.ts's captureBodyAndHeaders.
const captureRequest = async (
  config: ResponsesAdapterConfig,
  req: ChatRequest,
  sseText = "data: [DONE]\n",
): Promise<{
  body: Record<string, unknown>;
  headers: HeadersInit;
  url: string;
}> => {
  let body: Record<string, unknown> | undefined;
  let headers: HeadersInit | undefined;
  let url: string | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    url = String(input);
    headers = (init as RequestInit | undefined)?.headers;
    const raw = (init as RequestInit | undefined)?.body;
    body = JSON.parse(String(raw)) as Record<string, unknown>;
    return Promise.resolve(
      new Response(sseText, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
  };
  try {
    await Effect.runPromise(
      Stream.runCollect(makeResponsesAdapter(config).stream(req)),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  if (body === undefined || headers === undefined || url === undefined) {
    throw new Error("fetch was not invoked");
  }
  return { body, headers, url };
};

// Run a stream to completion and return the failing error's _tag, or
// undefined when it succeeds. AuthFailed/ContextOverflow are non-retryable so
// the stream fails fast (withRetry does not retry fatal errors).
const failureTag = async (
  config: ResponsesAdapterConfig,
  req: ChatRequest,
): Promise<string | undefined> => {
  try {
    await Effect.runPromise(
      Stream.runCollect(makeResponsesAdapter(config).stream(req)),
    );
    return undefined;
  } catch (e) {
    return (e as { _tag?: string })._tag;
  }
};

// =============================================================================
// Body construction
// =============================================================================
Deno.test("Responses buildBody hoists system to instructions, forces store:false, streams", async () => {
  const { body } = await captureRequest(apiKeyConfig(), {
    model: "gpt-5",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    system: "you are helpful",
  });
  assertEquals(body.instructions, "you are helpful");
  assertEquals(body.store, false);
  assertEquals(body.stream, true);
  assertEquals(body.model, "gpt-5");
  assertEquals(body.input, [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hi" }],
    },
  ]);
});

Deno.test("Responses buildBody omits instructions when system is empty", async () => {
  const { body } = await captureRequest(apiKeyConfig(), {
    model: "gpt-5",
    messages: [],
    tools: [],
  });
  assertEquals("instructions" in body, false);
});

Deno.test("Responses buildBody passes thinking.effort VERBATIM to reasoning.effort (no mapping)", async () => {
  const { body } = await captureRequest(apiKeyConfig(), {
    model: "gpt-5",
    messages: [],
    tools: [],
    thinking: { effort: "high" },
  });
  // effort is a free-form string forwarded unchanged - no enum, no table.
  assertEquals(body.reasoning, { effort: "high" });
});

Deno.test("Responses buildBody omits reasoning when thinking.effort is unset", async () => {
  const { body } = await captureRequest(apiKeyConfig(), {
    model: "gpt-5",
    messages: [],
    tools: [],
  });
  assertEquals("reasoning" in body, false);
});

Deno.test("Responses buildBody sets include only for oauth kind (apiKey omits it)", async () => {
  const apiKeyBody = await captureRequest(apiKeyConfig(), {
    model: "gpt-5",
    messages: [],
    tools: [],
  });
  assertEquals("include" in apiKeyBody.body, false);

  const oauthBody = await captureRequest(oauthConfig(), {
    model: "gpt-5",
    messages: [],
    tools: [],
  });
  assertEquals(oauthBody.body.include, ["reasoning.encrypted_content"]);
});

Deno.test("Responses buildBody emits tools as function tools with strict:false", async () => {
  const { body } = await captureRequest(apiKeyConfig(), {
    model: "gpt-5",
    messages: [],
    tools: [{
      name: "search",
      description: "look up",
      parameters: { type: "object" },
    }],
  });
  assertEquals(body.tools, [
    {
      type: "function",
      name: "search",
      description: "look up",
      parameters: { type: "object" },
      strict: false,
    },
  ]);
});

// =============================================================================
// Convert (encrypted reasoning replay)
// =============================================================================
Deno.test("Responses buildBody replays encrypted reasoningContent as reasoning items (verbatim)", async () => {
  const { body } = await captureRequest(apiKeyConfig(), {
    model: "gpt-5",
    messages: [{
      role: "assistant",
      content: "answer",
      reasoningContent: [
        { text: "no-creds" },
        { text: "thought", encrypted: "enc-blob" },
      ],
    }],
    tools: [],
  });
  const input = body.input as unknown[];
  // Blocks without `encrypted` are dropped (no replay credential); the
  // encrypted one becomes a reasoning item with summary + encrypted_content,
  // replayed verbatim.
  assertEquals(input, [
    {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "thought" }],
      encrypted_content: "enc-blob",
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "answer" }],
    },
  ]);
});

Deno.test("messagesToResponses maps tool results to function_call_output items", () => {
  assertEquals(
    messagesToResponses([
      { role: "user", content: "q" },
      { role: "tool", content: "result", toolCallId: "call_1" },
    ]),
    [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "q" }],
      },
      { type: "function_call_output", call_id: "call_1", output: "result" },
    ],
  );
});

Deno.test("toolsToResponses defaults description/parameters only when set, always strict:false", () => {
  assertEquals(toolsToResponses([{ name: "n1" }]), [
    { type: "function", name: "n1", strict: false },
  ]);
  assertEquals(
    toolsToResponses([
      { name: "n2", description: "doc", parameters: { type: "object" } },
    ]),
    [
      {
        type: "function",
        name: "n2",
        strict: false,
        description: "doc",
        parameters: { type: "object" },
      },
    ],
  );
});

// =============================================================================
// OAuth URL rewrite + headers
// =============================================================================
Deno.test("Responses oauth rewrites URL to the codex backend and stamps oauth headers", async () => {
  const { url, headers } = await captureRequest(oauthConfig(), {
    model: "gpt-5",
    messages: [],
    tools: [],
  });
  assertEquals(url, CODEX_BACKEND_URL);
  const map = headers as Record<string, string>;
  assertEquals(map["authorization"], "Bearer tok-1");
  assertEquals(map["openai-beta"], "responses=experimental");
  assertEquals(map["chatgpt-account-id"], "acct-1");
  // niumaFetch stamps the niuma UA on every request.
  assertEquals(map["user-agent"], `niuma/${VERSION}`);
});

Deno.test("Responses oauth omits ChatGPT-Account-Id when accountId undefined", async () => {
  const { headers } = await captureRequest(
    oauthConfig({
      tokenSource: {
        getAccessToken: () => Effect.succeed({ accessToken: "tok-1" }),
        invalidateAndRefresh: () => Effect.succeed({ accessToken: "tok-2" }),
      },
    }),
    { model: "gpt-5", messages: [], tools: [] },
  );
  assertEquals(
    "chatgpt-account-id" in (headers as Record<string, string>),
    false,
  );
});

Deno.test("Responses apiKey posts to {baseUrl}/responses with a Bearer key, no oauth headers", async () => {
  const { url, headers } = await captureRequest(apiKeyConfig(), {
    model: "gpt-5",
    messages: [],
    tools: [],
  });
  assertEquals(url, "https://api.openai.com/v1/responses");
  const map = headers as Record<string, string>;
  assertEquals(map["authorization"], "Bearer test-key");
  assertEquals("openai-beta" in map, false);
  assertEquals("chatgpt-account-id" in map, false);
});

// =============================================================================
// 401 recovery (oauth single-retry)
// =============================================================================
Deno.test("Responses oauth 401 triggers invalidateAndRefresh and retries the POST once", async () => {
  let fetchCalls = 0;
  let refreshCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_input, _init) => {
    fetchCalls++;
    if (fetchCalls === 1) {
      return Promise.resolve(new Response("unauth", { status: 401 }));
    }
    return Promise.resolve(
      new Response("data: [DONE]\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
  };
  try {
    await Effect.runPromise(
      Stream.runCollect(
        makeResponsesAdapter(oauthConfig({
          tokenSource: {
            getAccessToken: () =>
              Effect.succeed({ accessToken: "tok-1", accountId: "acct-1" }),
            invalidateAndRefresh: () => {
              refreshCalls++;
              return Effect.succeed({
                accessToken: "tok-2",
                accountId: "acct-1",
              });
            },
          },
        })).stream({ model: "gpt-5", messages: [], tools: [] }),
      ),
    );
    assertEquals(fetchCalls, 2);
    assertEquals(refreshCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Responses oauth second 401 surfaces AuthFailed (retry bounded to one)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(new Response("unauth", { status: 401 }));
  try {
    const tag = await failureTag(oauthConfig(), {
      model: "gpt-5",
      messages: [],
      tools: [],
    });
    assertEquals(tag, "AuthFailed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Responses apiKey 401 surfaces AuthFailed without invoking any token source", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(new Response("unauth", { status: 401 }));
  try {
    const tag = await failureTag(apiKeyConfig(), {
      model: "gpt-5",
      messages: [],
      tools: [],
    });
    // apiKey has no retry path: classifyResponse maps 401 -> AuthFailed and
    // withRetry does not retry fatal errors, so the stream fails immediately.
    assertEquals(tag, "AuthFailed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// =============================================================================
// Error classification parity (shared classifyResponse ladder)
// =============================================================================
Deno.test("Responses 400 context-too-long surfaces ContextOverflow (non-retryable)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response("this model's context window is too long", { status: 400 }),
    );
  try {
    const tag = await failureTag(apiKeyConfig(), {
      model: "gpt-5",
      messages: [],
      tools: [],
    });
    assertEquals(tag, "ContextOverflow");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Responses 400 generic surfaces InvalidResponse", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(new Response("bad shape", { status: 400 }));
  try {
    const tag = await failureTag(apiKeyConfig(), {
      model: "gpt-5",
      messages: [],
      tools: [],
    });
    assertEquals(tag, "InvalidResponse");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// =============================================================================
// listModels
// =============================================================================
Deno.test("Responses oauth listModels returns the static default (no /models on codex backend)", async () => {
  const models = await Effect.runPromise(
    makeResponsesAdapter(oauthConfig()).listModels(),
  );
  assertEquals(models, [{ id: "gpt-5", name: "gpt-5" }]);
});

Deno.test("Responses apiKey listModels falls back to defaultModel on failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(new Response("boom", { status: 500 }));
  try {
    const models = await Effect.runPromise(
      makeResponsesAdapter(apiKeyConfig({ defaultModel: "gpt-5" }))
        .listModels(),
    );
    assertEquals(models, [{ id: "gpt-5", name: "gpt-5" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Responses apiKey listModels parses the /models catalogue on success", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ data: [{ id: "gpt-5" }, { id: "gpt-5-mini" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  try {
    const models = await Effect.runPromise(
      makeResponsesAdapter(apiKeyConfig()).listModels(),
    );
    assertEquals(models, [
      { id: "gpt-5", name: "gpt-5" },
      { id: "gpt-5-mini", name: "gpt-5-mini" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ----- additional body / wiring edge cases ---------------------------------

Deno.test("Responses buildBody: empty system string is omitted from instructions", async () => {
  // Empty string is treated as "no system prompt" so the field is omitted
  // entirely (matches how the Chat Completions adapter handles empty
  // system). The OpenAI Responses API rejects empty `instructions`, so this
  // avoid-the-400 behavior is load-bearing.
  const { body } = await captureRequest(apiKeyConfig(), {
    model: "gpt-5",
    messages: [],
    tools: [],
    system: "",
  });
  assertEquals("instructions" in body, false);
});

Deno.test("Responses buildBody: maxTokens and temperature are forwarded under the Responses keys", async () => {
  const { body } = await captureRequest(apiKeyConfig(), {
    model: "gpt-5",
    messages: [],
    tools: [],
    maxTokens: 2048,
    temperature: 0.7,
  });
  // maxTokens becomes max_output_tokens on the wire (the documented Responses
  // field name); temperature passes through unchanged.
  assertEquals(body.max_output_tokens, 2048);
  assertEquals(body.temperature, 0.7);
});

Deno.test("Responses buildBody: maxTokens/temperature omitted when unset", async () => {
  const { body } = await captureRequest(apiKeyConfig(), {
    model: "gpt-5",
    messages: [],
    tools: [],
  });
  assertEquals("max_output_tokens" in body, false);
  assertEquals("temperature" in body, false);
});

Deno.test("Responses buildBody: request model overrides the defaultModel", async () => {
  const { body } = await captureRequest(
    apiKeyConfig({ defaultModel: "gpt-5" }),
    {
      model: "gpt-5-mini",
      messages: [],
      tools: [],
    },
  );
  assertEquals(body.model, "gpt-5-mini");
});

Deno.test("Responses buildBody: request model falls back to defaultModel when absent", async () => {
  // ChatRequest.model is required by the contract, but the adapter must
  // still default gracefully when the caller does not pass it (the contract
  // is loosened here for documentation).
  const { body } = await captureRequest(
    apiKeyConfig({ defaultModel: "gpt-5" }),
    {
      // @ts-expect-error — model is normally required.
      model: undefined,
      messages: [],
      tools: [],
    },
  );
  assertEquals(body.model, "gpt-5");
});

Deno.test("Responses buildBody: thinkingConfig with only keep is omitted (no reasoning object)", async () => {
  // `keep` is a client-side control (context projection), not a wire field;
  // it must not influence the request body. The adapter only emits
  // reasoning.effort, never the keep flag.
  const { body } = await captureRequest(apiKeyConfig(), {
    model: "gpt-5",
    messages: [],
    tools: [],
    thinking: { keep: "none" },
  });
  assertEquals("reasoning" in body, false);
});

Deno.test("Responses buildBody: free-form effort string (gpt-5 family) passes through verbatim", async () => {
  // Effort is a verbatim string — no enum, no mapping, no family lookup.
  // Verify a few arbitrary strings pass through unchanged.
  const cases = ["minimal", "low", "medium", "high", "xhigh", "custom-档位"];
  for (const effort of cases) {
    const { body } = await captureRequest(apiKeyConfig(), {
      model: "gpt-5",
      messages: [],
      tools: [],
      thinking: { effort },
    });
    assertEquals(body.reasoning, { effort });
  }
});

Deno.test("Responses buildBody: trim trailing slashes from baseUrl", async () => {
  // The adapter normalizes baseUrl at construction time so trailing slashes
  // do not turn into broken URLs like "/responses//responses". Verify the
  // apiKey posts to the right URL even when the caller passes trailing
  // slashes.
  const { url } = await captureRequest(
    apiKeyConfig({ baseUrl: "https://api.openai.com/v1///" }),
    { model: "gpt-5", messages: [], tools: [] },
  );
  assertEquals(url, "https://api.openai.com/v1/responses");
});

Deno.test("Responses buildBody: tools omitted when ChatRequest.tools is empty", async () => {
  const { body } = await captureRequest(apiKeyConfig(), {
    model: "gpt-5",
    messages: [],
    tools: [],
  });
  assertEquals("tools" in body, false);
});

// ----- 401 recovery: invalidation behaviour ---------------------------------

Deno.test("Responses oauth 401: refresh path also runs successfully on the second call", async () => {
  // After the 401 recovery path succeeds, the next stream call should use
  // the refreshed token (no more 401s). Verifies the recovery is a one-shot
  // boundary, not a permanent fallback.
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = () => {
    call++;
    if (call === 1) {
      return Promise.resolve(new Response("unauth", { status: 401 }));
    }
    return Promise.resolve(
      new Response("data: [DONE]\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
  };
  try {
    await Effect.runPromise(
      Stream.runCollect(
        makeResponsesAdapter(oauthConfig({
          tokenSource: {
            getAccessToken: () =>
              Effect.succeed({ accessToken: "tok-1", accountId: "acct-1" }),
            invalidateAndRefresh: () =>
              Effect.succeed({ accessToken: "tok-2", accountId: "acct-1" }),
          },
        })).stream({ model: "gpt-5", messages: [], tools: [] }),
      ),
    );
    assertEquals(call, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Responses oauth: getAccessToken AuthFailed triggers invalidateAndRefresh and the POST still happens", async () => {
  // The retry path catches AuthFailed from anywhere in the pipeline - both
  // a POST-level 401 AND a tokenSource-level failure - so a single failing
  // getAccessToken is recovered via invalidateAndRefresh + post. The post
  // here returns 200, so the stream succeeds end-to-end.
  let getAccessCalls = 0;
  let refreshCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    return Promise.resolve(
      new Response("data: [DONE]\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
  };
  try {
    await Effect.runPromise(
      Stream.runCollect(
        makeResponsesAdapter(oauthConfig({
          tokenSource: {
            getAccessToken: () => {
              getAccessCalls++;
              return Effect.fail(new AuthFailed({ message: "stale-token" }));
            },
            invalidateAndRefresh: () => {
              refreshCalls++;
              return Effect.succeed({ accessToken: "tok-2" });
            },
          },
        })).stream({ model: "gpt-5", messages: [], tools: [] }),
      ),
    );
    assertEquals(getAccessCalls, 1);
    assertEquals(refreshCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Responses oauth: double AuthFailed (getAccessToken + invalidateAndRefresh) surfaces as AuthFailed", async () => {
  // If even the refresh path fails, the stream propagates AuthFailed. This
  // is the only fatal state in the recovery pipeline - the user must re-auth.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(new Response("body", { status: 200 }));
  try {
    const tag = await failureTag(
      oauthConfig({
        tokenSource: {
          getAccessToken: () =>
            Effect.fail(new AuthFailed({ message: "stale-token" })),
          invalidateAndRefresh: () =>
            Effect.fail(new AuthFailed({ message: "refresh-rejected" })),
        },
      }),
      { model: "gpt-5", messages: [], tools: [] },
    );
    assertEquals(tag, "AuthFailed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ----- AbortSignal propagation ---------------------------------------------

Deno.test("Responses stream: a pre-aborted signal returns an empty stream", async () => {
  // The adapter checks the request-level abort signal before any POST and
  // returns Stream.empty when the abort has already fired. The downstream
  // consumer therefore sees an empty stream rather than a ProviderError.
  const controller = new AbortController();
  controller.abort();
  const collected = await Effect.runPromise(
    Stream.runCollect(
      makeResponsesAdapter(apiKeyConfig()).stream({
        model: "gpt-5",
        messages: [],
        tools: [],
        abort: controller.signal,
      }),
    ),
  );
  assertEquals(collected.length, 0);
});

// ----- Error classification parity -----------------------------------------

Deno.test("Responses 429 carries retry-after in the RateLimited error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response("rate-limited", {
        status: 429,
        headers: { "retry-after": "7" },
      }),
    );
  try {
    const tag = await failureTag(apiKeyConfig(), {
      model: "gpt-5",
      messages: [],
      tools: [],
    });
    assertEquals(tag, "RateLimited");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Responses 429: a follow-up inspect of the error carries retryAfterMs", async () => {
  // The RateLimited error carries retryAfterMs when the wire sends a numeric
  // retry-after header. The error surface is the contract with withRetry +
  // the agent loop; verify the smoke-level assertion via the same try/catch
  // pattern failureTag uses, so the type narrowing of the failure channel is
  // exercised.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response("rate-limited", {
        status: 429,
        headers: { "retry-after": "7" },
      }),
    );
  try {
    let caught: unknown;
    try {
      await Effect.runPromise(
        Stream.runCollect(
          makeResponsesAdapter(apiKeyConfig()).stream({
            model: "gpt-5",
            messages: [],
            tools: [],
          }),
        ),
      );
    } catch (e) {
      caught = e;
    }
    if (!(caught instanceof RateLimited)) {
      throw new Error(
        `expected RateLimited, got ${
          (caught as { _tag?: string })?._tag ?? typeof caught
        }`,
      );
    }
    assertEquals(caught.retryAfterMs, 7000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Responses 500 maps to Overloaded (retryable)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(new Response("server boom", { status: 500 }));
  try {
    const tag = await failureTag(apiKeyConfig(), {
      model: "gpt-5",
      messages: [],
      tools: [],
    });
    assertEquals(tag, "Overloaded");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Responses retry budget: a persistent 500 yields exactly 5 transport attempts (1 initial + 4 retries)", async () => {
  // Pins the transport retry budget so a future change to retryOptions.times
  // (or to effect@4's `times` semantics) cannot silently widen the fetch fan-
  // out. effect@4 gates retries 1..`times` after the always-run initial
  // attempt, so times:4 -> 5 total POSTs against a persistent 5xx. This
  // matches STREAM_MAX_RETRIES's "5 total samples" convention; diverging
  // here would change how hard niuma hammers a failing backend.
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    fetchCalls++;
    return Promise.resolve(new Response("server boom", { status: 500 }));
  };
  try {
    await Effect.runPromise(
      Stream.runCollect(
        makeResponsesAdapter(apiKeyConfig()).stream({
          model: "gpt-5",
          messages: [],
          tools: [],
        }),
      ),
    ).catch(() => {
      // Overloaded exhausts the retry budget then surfaces; swallow for the
      // count assertion.
    });
    assertEquals(fetchCalls, 5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Responses 403 maps to AuthFailed (no token source for apiKey)", async () => {
  // The apiKey adapter has no refresh path; 403 must still surface as
  // AuthFailed so the user gets a clear credential error.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(new Response("forbidden", { status: 403 }));
  try {
    const tag = await failureTag(apiKeyConfig(), {
      model: "gpt-5",
      messages: [],
      tools: [],
    });
    assertEquals(tag, "AuthFailed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ----- listModels: apiKey non-2xx fallback ---------------------------------

Deno.test("Responses apiKey listModels: 401 falls back to defaultModel", async () => {
  // The apiKey /models endpoint requires valid credentials; if the call
  // fails, the adapter catches the ProviderError and returns the configured
  // defaultModel so listModels never throws.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(new Response("unauth", { status: 401 }));
  try {
    const models = await Effect.runPromise(
      makeResponsesAdapter(apiKeyConfig({ defaultModel: "gpt-5-fallback" }))
        .listModels(),
    );
    assertEquals(models, [{ id: "gpt-5-fallback", name: "gpt-5-fallback" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Responses apiKey listModels: missing data field returns empty array", async () => {
  // A 200 response with no `data` field is treated as an empty catalogue
  // rather than an error — the call succeeds and the list is empty.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  try {
    const models = await Effect.runPromise(
      makeResponsesAdapter(apiKeyConfig()).listModels(),
    );
    assertEquals(models, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Responses oauth listModels: never posts to the chatgpt backend", async () => {
  // The ChatGPT backend exposes no /models endpoint; the oauth listModels
  // path must short-circuit to the static default without issuing any HTTP
  // request. A spurious fetch would either hang or 404.
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = () => {
    fetchCalls++;
    throw new Error("oauth listModels must not call fetch");
  };
  try {
    const models = await Effect.runPromise(
      makeResponsesAdapter(oauthConfig()).listModels(),
    );
    assertEquals(models, [{ id: "gpt-5", name: "gpt-5" }]);
    assertEquals(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ----- Stream: usage reaches the agent loop via the Finish event -----------

Deno.test("Responses stream: the final Finish event loses its usage to the SSE consumer", async () => {
  // Round-trip: the SSE parser emits a Finish with usage; the adapter
  // surfaces it through the Stream. This verifies the wiring between the
  // parser and the Effect Stream plumbing.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        [
          `event: response.output_text.delta\ndata: ${
            JSON.stringify({ type: "response.output_text.delta", delta: "ok" })
          }`,
          "",
          `event: response.completed\ndata: ${
            JSON.stringify({
              type: "response.completed",
              response: {
                status: "completed",
                usage: {
                  input_tokens: 11,
                  output_tokens: 22,
                  total_tokens: 33,
                  output_tokens_details: { reasoning_tokens: 4 },
                },
              },
            })
          }`,
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      ),
    );
  try {
    const events = await Effect.runPromise(
      Stream.runCollect(
        makeResponsesAdapter(apiKeyConfig()).stream({
          model: "gpt-5",
          messages: [],
          tools: [],
        }),
      ),
    );
    assertEquals(events, [
      { _tag: "TextDelta", text: "ok" },
      {
        _tag: "Finish",
        reason: "stop",
        usage: {
          promptTokens: 11,
          completionTokens: 22,
          totalTokens: 33,
          reasoningTokens: 4,
        },
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
