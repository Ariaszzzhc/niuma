import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { Effect, Stream } from "effect";
import {
  makeAnthropicAdapter,
  messagesToAnthropic,
  toolsToAnthropic,
} from "../src/anthropic.ts";
import { parseAnthropicSSE } from "../src/anthropic_sse.ts";
import type { ChatRequest, StreamEvent } from "../src/domain.ts";

// SSE for the Anthropic stream parser is keyed by `event:` headers rather than
// the data JSON, so each chunk of an event-stream run needs both labels —
// mirroring the wire shape, not OpenAI's "every line is data".
const sseEvent = (
  event: string,
  data: Record<string, unknown>,
): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const sseBody = (...events: ReadonlyArray<readonly [string, Record<string, unknown>]>):
  ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  const text = events.map(([e, d]) => sseEvent(e, d)).join("");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
};

const collectSSE = async (
  ...events: ReadonlyArray<readonly [string, Record<string, unknown>]>
): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = [];
  for await (
    const event of parseAnthropicSSE(sseBody(...events), new AbortController().signal)
  ) {
    out.push(event);
  }
  return out;
};

Deno.test("parseAnthropicSSE emits full event sequence ending in tool_calls Finish", async () => {
  const events = await collectSSE(
    ["message_start", { message: { usage: { input_tokens: 12 } } }],
    [
      "content_block_start",
      { index: 0, content_block: { type: "thinking", thinking: "" } },
    ],
    ["content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "plan" } }],
    [
      "content_block_delta",
      { index: 0, delta: { type: "signature_delta", signature: "sig-A" } },
    ],
    ["content_block_stop", { index: 0 }],
    [
      "content_block_start",
      { index: 1, content_block: { type: "text", text: "" } },
    ],
    ["content_block_delta", { index: 1, delta: { type: "text_delta", text: "Hello " } }],
    ["content_block_delta", { index: 1, delta: { type: "text_delta", text: "world" } }],
    ["content_block_stop", { index: 1 }],
    [
      "content_block_start",
      { index: 2, content_block: { type: "tool_use", id: "call_1", name: "lookup" } },
    ],
    ["content_block_delta", { index: 2, delta: { type: "input_json_delta", partial_json: '{"q' } }],
    ["content_block_delta", { index: 2, delta: { type: "input_json_delta", partial_json: 'uery":"x"}' } }],
    ["content_block_stop", { index: 2 }],
    [
      "message_delta",
      { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
    ],
    ["message_stop", {}],
  );

  assertEquals(events, [
    { _tag: "ThinkingDelta", text: "plan" },
    { _tag: "ThinkingDelta", text: "", encrypted: "sig-A" },
    { _tag: "TextDelta", text: "Hello " },
    { _tag: "TextDelta", text: "world" },
    {
      _tag: "ToolCall",
      id: "call_1",
      name: "lookup",
      arguments: '{"query":"x"}',
    },
    {
      _tag: "Finish",
      reason: "tool_calls",
      usage: {
        promptTokens: 12,
        completionTokens: 7,
        totalTokens: 19,
      },
    },
  ]);
});

Deno.test("parseAnthropicSSE emits redacted_thinking as encrypted-only ThinkingDelta", async () => {
  const events = await collectSSE(
    ["message_start", { message: { usage: { input_tokens: 4 } } }],
    [
      "content_block_start",
      { index: 0, content_block: { type: "redacted_thinking", data: "blob-data" } },
    ],
    ["content_block_stop", { index: 0 }],
    ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } }],
    ["content_block_stop", { index: 1 }],
    ["message_delta", { delta: { stop_reason: "end_turn" } }],
    ["message_stop", {}],
  );

  assertEquals(events, [
    { _tag: "ThinkingDelta", text: "", encrypted: "blob-data" },
    { _tag: "TextDelta", text: "ok" },
    { _tag: "Finish", reason: "stop" },
  ]);
});

Deno.test("parseAnthropicSSE maps stop_reasons end_turn / max_tokens / tool_use", async () => {
  const endTurn = await collectSSE(
    ["message_start", { message: { usage: { input_tokens: 1 } } }],
    ["message_delta", { delta: { stop_reason: "end_turn" } }],
    ["message_stop", {}],
  );
  assertEquals(endTurn, [{ _tag: "Finish", reason: "stop" }]);

  const maxTokens = await collectSSE(
    ["message_start", { message: { usage: { input_tokens: 1 } } }],
    ["message_delta", { delta: { stop_reason: "max_tokens" } }],
    ["message_stop", {}],
  );
  assertEquals(maxTokens, [{ _tag: "Finish", reason: "length" }]);

  const toolUse = await collectSSE(
    ["message_start", { message: { usage: { input_tokens: 1 } } }],
    [
      "content_block_start",
      {
        index: 0,
        content_block: { type: "tool_use", id: "c", name: "n" },
      },
    ],
    [
      "content_block_delta",
      { index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
    ],
    ["content_block_stop", { index: 0 }],
    ["message_delta", { delta: { stop_reason: "tool_use" } }],
    ["message_stop", {}],
  );
  assertEquals(toolUse, [
    { _tag: "ToolCall", id: "c", name: "n", arguments: "{}" },
    { _tag: "Finish", reason: "tool_calls" },
  ]);
});

// =============================================================================
// buildBody
// =============================================================================
const captureBodyAndHeaders = async (
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
    return Promise.resolve(new Response(sseText, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
  };
  try {
    const adapter = makeAnthropicAdapter({
      baseUrl: "https://example.test",
      apiKey: "test-key",
      defaultModel: "fallback-model",
    });
    await Effect.runPromise(Stream.runCollect(adapter.stream(req)));
  } finally {
    globalThis.fetch = originalFetch;
  }
  if (body === undefined || headers === undefined || url === undefined) {
    throw new Error("fetch was not invoked");
  }
  return { body, headers, url };
};

Deno.test("Anthropic buildBody maps thinking_effort 'medium' to budget_tokens 4096 and grows max_tokens", async () => {
  const { body } = await captureBodyAndHeaders({
    model: "m",
    messages: [],
    tools: [],
    maxTokens: 2000,
    thinking: { effort: "medium" },
  });
  assertEquals(body.thinking, { type: "enabled", budget_tokens: 4096 });
  // max_tokens must clear budget (Anthropic rejects otherwise).
  assertEquals(
    (body.max_tokens as number) > 4096,
    true,
  );
});

Deno.test("Anthropic buildBody maps numeric effort literally", async () => {
  const { body } = await captureBodyAndHeaders({
    model: "m",
    messages: [],
    tools: [],
    thinking: { effort: "8192" },
  });
  assertEquals(body.thinking, { type: "enabled", budget_tokens: 8192 });
});

Deno.test("Anthropic buildBody omits thinking field for effort 'none'", async () => {
  const { body } = await captureBodyAndHeaders({
    model: "m",
    messages: [],
    tools: [],
    thinking: { effort: "none" },
  });
  assertEquals("thinking" in body, false);
});

Deno.test("Anthropic buildBody strips temperature when thinking is enabled", async () => {
  const { body } = await captureBodyAndHeaders({
    model: "m",
    messages: [],
    tools: [],
    temperature: 0.7,
    thinking: { effort: "high" },
  });
  assertEquals("temperature" in body, false);
  assertEquals(body.thinking, { type: "enabled", budget_tokens: 32000 });
});

Deno.test("Anthropic buildBody keeps temperature when thinking is off", async () => {
  const { body } = await captureBodyAndHeaders({
    model: "m",
    messages: [],
    tools: [],
    temperature: 0.7,
  });
  assertEquals(body.temperature, 0.7);
});

Deno.test("Anthropic request headers use x-api-key and anthropic-version, no Authorization", async () => {
  const { headers, url } = await captureBodyAndHeaders({
    model: "m",
    messages: [],
    tools: [],
  });
  const map = headers as Record<string, string>;
  assertEquals(map["x-api-key"], "test-key");
  assertEquals(map["anthropic-version"], "2023-06-01");
  assertEquals("authorization" in map, false);
  assertEquals(url, "https://example.test/v1/messages");
});

// =============================================================================
// Convert (messages → Anthropic wire)
// =============================================================================
Deno.test("messagesToAnthropic emits assistant toolCalls as tool_use blocks", () => {
  const out = messagesToAnthropic([{
    role: "assistant",
    content: "going to look up",
    toolCalls: [{
      id: "call_1",
      name: "lookup",
      arguments: '{"query":"x"}',
    }],
  }]);

  assertEquals(out, [{
    role: "assistant",
    content: [
      { type: "text", text: "going to look up" },
      {
        type: "tool_use",
        id: "call_1",
        name: "lookup",
        input: { query: "x" },
      },
    ],
  }]);
});

Deno.test("messagesToAnthropic merges consecutive tool messages into one user tool_result batch", () => {
  const out = messagesToAnthropic([
    {
      role: "tool",
      content: "first",
      toolCallId: "id-1",
    },
    {
      role: "tool",
      content: "second",
      toolCallId: "id-2",
    },
    { role: "user", content: "next question" },
  ]);

  assertEquals(out, [
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "id-1", content: "first" },
        { type: "tool_result", tool_use_id: "id-2", content: "second" },
      ],
    },
    {
      role: "user",
      content: [{ type: "text", text: "next question" }],
    },
  ]);
});

Deno.test("messagesToAnthropic keeps only signed thinking blocks (drops signature-less reasoning text)", () => {
  const out = messagesToAnthropic([{
    role: "assistant",
    content: "answer",
    reasoningContent: [
      { text: "without-creds" },
      { text: "with-creds", encrypted: "sig-xyz" },
    ],
  }]);

  // First thinking block (no encrypted) is discarded; the signed one leads the
  // turn and is paired with the visible text afterwards.
  assertEquals(out, [{
    role: "assistant",
    content: [
      {
        type: "thinking",
        thinking: "with-creds",
        signature: "sig-xyz",
      },
      { type: "text", text: "answer" },
    ],
  }]);
});

Deno.test("toolsToAnthropic defaults to empty input_schema and forwards description only when set", () => {
  assertEquals(toolsToAnthropic([
    { name: "n1" },
    { name: "n2", description: "doc", parameters: { type: "object" } },
  ]), [
    { name: "n1", input_schema: {} },
    { name: "n2", description: "doc", input_schema: { type: "object" } },
  ]);
});

// =============================================================================
// listModels
// =============================================================================
Deno.test("Anthropic listModels falls back to defaultModel on failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response("boom", { status: 500 }));
  try {
    const adapter = makeAnthropicAdapter({
      baseUrl: "https://example.test",
      apiKey: "k",
      defaultModel: "claude-fallback",
    });
    const models = await Effect.runPromise(adapter.listModels());
    assertEquals(models, [{ id: "claude-fallback", name: "claude-fallback" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Anthropic listModels parses the documented /v1/models response on success", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(new Response(
      JSON.stringify({
        data: [
          { id: "claude-x", display_name: "Claude X" },
          { id: "claude-y" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
  try {
    const adapter = makeAnthropicAdapter({
      baseUrl: "https://example.test",
      apiKey: "k",
      defaultModel: "claude-fallback",
    });
    const models = await Effect.runPromise(adapter.listModels());
    assertEquals(models, [
      { id: "claude-x", name: "Claude X" },
      { id: "claude-y", name: "claude-y" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
