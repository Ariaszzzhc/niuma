import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { Effect, Stream } from "effect";
import { messagesToOpenAI } from "../src/convert.ts";
import type { ChatRequest, StreamEvent } from "../src/domain.ts";
import { makeOpenAIAdapter } from "../src/openai.ts";
import { parseOpenAISSE } from "../src/sse.ts";

const sseBody = (...chunks: ReadonlyArray<Record<string, unknown>>): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  const text = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n`).join("") +
    "data: [DONE]\n";
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
};

const collectSSE = async (
  ...chunks: ReadonlyArray<Record<string, unknown>>
): Promise<StreamEvent[]> => {
  const events: StreamEvent[] = [];
  for await (const event of parseOpenAISSE(sseBody(...chunks), new AbortController().signal)) {
    events.push(event);
  }
  return events;
};

Deno.test("parseOpenAISSE emits reasoning content as ThinkingDelta", async () => {
  const events = await collectSSE({
    choices: [{ index: 0, delta: { reasoning_content: "reasoning" } }],
  });

  assertEquals(events, [
    { _tag: "ThinkingDelta", text: "reasoning" },
    { _tag: "Finish", reason: "stop" },
  ]);
});

Deno.test("parseOpenAISSE maps reasoning token usage", async () => {
  const events = await collectSSE({
    choices: [],
    usage: {
      prompt_tokens: 3,
      completion_tokens: 5,
      total_tokens: 8,
      completion_tokens_details: { reasoning_tokens: 2 },
    },
  });

  assertEquals(events, [{
    _tag: "Finish",
    reason: "stop",
    usage: {
      promptTokens: 3,
      completionTokens: 5,
      totalTokens: 8,
      reasoningTokens: 2,
    },
  }]);
});

Deno.test("messagesToOpenAI emits assistant reasoning_content", () => {
  assertEquals(messagesToOpenAI([{
    role: "assistant",
    content: "answer",
    reasoningContent: [
      { text: "rea" },
      { text: "soning", encrypted: "opaque" },
    ],
  }]), [{
    role: "assistant",
    content: "answer",
    reasoning_content: "reasoning",
  }]);
});

Deno.test("OpenAI request body includes reasoning_effort", async () => {
  let body: Record<string, unknown> | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_input, init) => {
    const raw = (init as RequestInit | undefined)?.body;
    body = JSON.parse(String(raw)) as Record<string, unknown>;
    return Promise.resolve(new Response("data: [DONE]\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
  };

  try {
    const req: ChatRequest = {
      model: "test-model",
      messages: [],
      tools: [],
      thinking: { effort: "high" },
    };
    const adapter = makeOpenAIAdapter({
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      defaultModel: "test-model",
    });
    await Effect.runPromise(Stream.runCollect(adapter.stream(req)));
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertEquals(body?.reasoning_effort, "high");
});
