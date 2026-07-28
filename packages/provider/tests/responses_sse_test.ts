import { assertEquals, assertRejects } from "@std/assert";
import type { StreamEvent } from "../src/domain.ts";
import { InvalidResponse } from "../src/errors.ts";
import { parseResponsesSSE } from "../src/responses_sse.ts";

// Responses SSE fixtures mirror the wire format: each event is an `event:`
// line carrying the type plus a `data:` line carrying the JSON body (which
// also repeats the type in its `type` field - that field is what the parser
// keys off, so dropping the `event:` line would parse identically).
const evt = (type: string, body: Record<string, unknown>): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}`;

const sse = (...events: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  // Events separated by a blank line, the SSE record terminator.
  const text = events.join("\n\n") + "\n\n";
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
};

const collect = async (...events: string[]): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = [];
  for await (
    const e of parseResponsesSSE(sse(...events), new AbortController().signal)
  ) {
    out.push(e);
  }
  return out;
};

const drain = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
  for await (
    const _ of parseResponsesSSE(stream, new AbortController().signal)
  ) {
    /* drain */
  }
};

Deno.test("parseResponsesSSE emits text + reasoning + tool call, tool_calls wins over stop", async () => {
  const events = await collect(
    evt("response.reasoning_summary_text.delta", { delta: "plan" }),
    evt("response.output_item.done", {
      item: {
        type: "reasoning",
        id: "rs_1",
        encrypted_content: "enc-1",
        summary: [{ type: "summary_text", text: "plan" }],
      },
    }),
    evt("response.output_text.delta", { delta: "Hello " }),
    evt("response.output_text.delta", { delta: "world" }),
    evt("response.output_item.done", {
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "lookup",
        arguments: '{"query":"x"}',
      },
    }),
    evt("response.completed", {
      response: {
        status: "completed",
        usage: {
          input_tokens: 12,
          output_tokens: 7,
          total_tokens: 19,
          output_tokens_details: { reasoning_tokens: 3 },
        },
      },
    }),
  );

  assertEquals(events, [
    { _tag: "ThinkingDelta", text: "plan" },
    { _tag: "ThinkingDelta", text: "", encrypted: "enc-1" },
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
        reasoningTokens: 3,
      },
    },
  ]);
});

Deno.test("parseResponsesSSE maps completed status without tool calls to stop", async () => {
  const events = await collect(
    evt("response.output_text.delta", { delta: "hi" }),
    evt("response.completed", {
      response: {
        status: "completed",
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
      },
    }),
  );
  assertEquals(events, [
    { _tag: "TextDelta", text: "hi" },
    {
      _tag: "Finish",
      reason: "stop",
      usage: {
        promptTokens: 2,
        completionTokens: 1,
        totalTokens: 3,
      },
    },
  ]);
});

Deno.test("parseResponsesSSE maps incomplete + max_output_tokens to length", async () => {
  const events = await collect(
    evt("response.incomplete", {
      response: {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        usage: { input_tokens: 5, output_tokens: 10, total_tokens: 15 },
      },
    }),
  );
  assertEquals(events, [
    {
      _tag: "Finish",
      reason: "length",
      usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 },
    },
  ]);
});

Deno.test("parseResponsesSSE falls back total_tokens to input+output when wire omits it", async () => {
  const events = await collect(
    evt("response.completed", {
      response: {
        status: "completed",
        usage: {
          input_tokens: 4,
          output_tokens: 6,
          output_tokens_details: { reasoning_tokens: 2 },
        },
      },
    }),
  );
  assertEquals(events, [
    {
      _tag: "Finish",
      reason: "stop",
      usage: {
        // total_tokens absent on the wire -> input+output.
        promptTokens: 4,
        completionTokens: 6,
        totalTokens: 10,
        reasoningTokens: 2,
      },
    },
  ]);
});

Deno.test("parseResponsesSSE skips unknown event types (forward-compatible)", async () => {
  const events = await collect(
    evt("response.created", { response: { id: "resp_1" } }),
    evt("response.web_search_call.in_progress", {
      item: { type: "web_search_call" },
    }),
    evt("response.output_text.delta", { delta: "ok" }),
    evt("response.completed", { response: { status: "completed" } }),
  );
  assertEquals(events, [
    { _tag: "TextDelta", text: "ok" },
    { _tag: "Finish", reason: "stop" },
  ]);
});

Deno.test("parseResponsesSSE omits encrypted when reasoning item lacks encrypted_content", async () => {
  const events = await collect(
    evt("response.reasoning_summary_text.delta", { delta: "think" }),
    // Reasoning item done without encrypted_content: no trailing credential
    // delta is emitted (the summary already streamed).
    evt("response.output_item.done", {
      item: {
        type: "reasoning",
        id: "rs_2",
        summary: [{ type: "summary_text", text: "think" }],
      },
    }),
    evt("response.completed", { response: { status: "completed" } }),
  );
  assertEquals(events, [
    { _tag: "ThinkingDelta", text: "think" },
    { _tag: "Finish", reason: "stop" },
  ]);
});

Deno.test("parseResponsesSSE throws InvalidResponse on malformed JSON", async () => {
  await assertRejects(
    () =>
      drain(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: {not json\n\n"));
            controller.close();
          },
        }),
      ),
    InvalidResponse,
  );
});

Deno.test("parseResponsesSSE emits a stop Finish on a [DONE] sentinel with no completed event", async () => {
  // Some proxies terminate the stream with [DONE] before response.completed;
  // the parser must still emit a Finish (default reason "stop").
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          evt("response.output_text.delta", { delta: "tail" }) + "\n\n" +
            "data: [DONE]\n\n",
        ),
      );
      controller.close();
    },
  });
  const out: StreamEvent[] = [];
  for await (
    const e of parseResponsesSSE(stream, new AbortController().signal)
  ) {
    out.push(e);
  }
  assertEquals(out, [
    { _tag: "TextDelta", text: "tail" },
    { _tag: "Finish", reason: "stop" },
  ]);
});

// ----- edge cases ------------------------------------------------------------

Deno.test("parseResponsesSSE: response.output_item.done with no item is a no-op", async () => {
  // The wire occasionally surfaces an output_item.done without the item
  // payload (rare but legal); the parser must skip it without crashing.
  const events = await collect(
    evt("response.output_item.done", {}),
    evt("response.output_text.delta", { delta: "ok" }),
    evt("response.completed", { response: { status: "completed" } }),
  );
  assertEquals(events, [
    { _tag: "TextDelta", text: "ok" },
    { _tag: "Finish", reason: "stop" },
  ]);
});

Deno.test("parseResponsesSSE: response.output_item.done reasoning without encrypted_content is a no-op", async () => {
  // Two reasoning items: the first carries encrypted content (as expected),
  // the second has the same shape but no encrypted_content. The first
  // becomes a ThinkingDelta with the credential; the second is silently
  // skipped (summary already streamed via the *_summary_text.delta events).
  const events = await collect(
    evt("response.reasoning_summary_text.delta", { delta: "a" }),
    evt("response.output_item.done", {
      item: {
        type: "reasoning",
        id: "r1",
        encrypted_content: "enc-1",
        summary: [{ type: "summary_text", text: "a" }],
      },
    }),
    evt("response.output_item.done", {
      item: {
        type: "reasoning",
        id: "r2",
        summary: [{ type: "summary_text", text: "b" }],
      },
    }),
    evt("response.completed", { response: { status: "completed" } }),
  );
  assertEquals(events, [
    { _tag: "ThinkingDelta", text: "a" },
    { _tag: "ThinkingDelta", text: "", encrypted: "enc-1" },
    { _tag: "Finish", reason: "stop" },
  ]);
});

Deno.test("parseResponsesSSE: response.output_item.done function_call falls back to item.id when call_id missing", async () => {
  // The wire definition allows call_id to be omitted on the item itself.
  // The parser must fall back to item.id so the function_call_output items
  // downstream can still reference the call.
  const events = await collect(
    evt("response.output_item.done", {
      item: {
        type: "function_call",
        id: "fc-only",
        name: "lookup",
        arguments: '{"x":1}',
      },
    }),
    evt("response.completed", { response: { status: "completed" } }),
  );
  assertEquals(events, [
    {
      _tag: "ToolCall",
      id: "fc-only",
      name: "lookup",
      arguments: '{"x":1}',
    },
    { _tag: "Finish", reason: "tool_calls" },
  ]);
});

Deno.test("parseResponsesSSE: response.incomplete with unknown reason still maps to stop", async () => {
  // Only max_output_tokens maps to "length"; every other incomplete reason
  // is treated as a normal stop (the wire is the source of truth).
  const events = await collect(
    evt("response.output_text.delta", { delta: "partial" }),
    evt("response.incomplete", {
      response: {
        status: "incomplete",
        incomplete_details: { reason: "content_filter" },
      },
    }),
  );
  assertEquals(events, [
    { _tag: "TextDelta", text: "partial" },
    { _tag: "Finish", reason: "stop" },
  ]);
});

Deno.test("parseResponsesSSE: response.completed with no usage omits the usage field", async () => {
  // Some Responses completions carry no usage block. The Finish.usage must
  // be omitted entirely (not just set to undefined) so downstream consumers
  // can distinguish "absent" from "zero".
  const events = await collect(
    evt("response.output_text.delta", { delta: "ok" }),
    evt("response.completed", { response: { status: "completed" } }),
  );
  assertEquals(events, [
    { _tag: "TextDelta", text: "ok" },
    { _tag: "Finish", reason: "stop" },
  ]);
});

Deno.test("parseResponsesSSE: a stream with no events ends with a default Finish", async () => {
  // The server may close the connection without ever sending an event. The
  // parser must still emit a Finish event so the consumer doesn't hang.
  const stream = new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
  const out: StreamEvent[] = [];
  for await (
    const e of parseResponsesSSE(stream, new AbortController().signal)
  ) {
    out.push(e);
  }
  assertEquals(out, [{ _tag: "Finish", reason: "stop" }]);
});

Deno.test("parseResponsesSSE: data line with leading whitespace after the colon is parsed", async () => {
  // SSE uses \r\n endings on the wire; the parser must accept the trailing
  // \r and any leading whitespace after "data:".
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `event: response.output_text.delta\r\ndata:   ${
            JSON.stringify({ type: "response.output_text.delta", delta: "x" })
          }\r\n\r\ndata: [DONE]\r\n\r\n`,
        ),
      );
      controller.close();
    },
  });
  const out: StreamEvent[] = [];
  for await (
    const e of parseResponsesSSE(stream, new AbortController().signal)
  ) {
    out.push(e);
  }
  assertEquals(out, [
    { _tag: "TextDelta", text: "x" },
    { _tag: "Finish", reason: "stop" },
  ]);
});

Deno.test("parseResponsesSSE: empty delta text in output_text.delta is skipped", async () => {
  // A zero-length delta should not be emitted as a TextDelta — keeps the
  // stream tidy and matches how the OpenAI parser treats empty deltas.
  const events = await collect(
    evt("response.output_text.delta", { delta: "" }),
    evt("response.output_text.delta", { delta: "ok" }),
    evt("response.completed", { response: { status: "completed" } }),
  );
  assertEquals(events, [
    { _tag: "TextDelta", text: "ok" },
    { _tag: "Finish", reason: "stop" },
  ]);
});

Deno.test("parseResponsesSSE: response.output_item.done with no type is a no-op", async () => {
  // The schema allows an item without a type discriminator. The parser must
  // skip it cleanly.
  const events = await collect(
    evt("response.output_item.done", {
      item: { id: "weird", name: "x" },
    }),
    evt("response.output_text.delta", { delta: "ok" }),
    evt("response.completed", { response: { status: "completed" } }),
  );
  assertEquals(events, [
    { _tag: "TextDelta", text: "ok" },
    { _tag: "Finish", reason: "stop" },
  ]);
});

Deno.test("parseResponsesSSE: text fragments stream in the order the wire delivered them", async () => {
  // Forces the parser to NOT coalesce multiple text deltas into one; the
  // downstream pipeline may rely on per-delta sequencing (e.g. for typing
  // indicators or markdown renders with progressive syntax).
  const events = await collect(
    evt("response.output_text.delta", { delta: "a" }),
    evt("response.output_text.delta", { delta: "b" }),
    evt("response.output_text.delta", { delta: "c" }),
    evt("response.completed", { response: { status: "completed" } }),
  );
  assertEquals(events, [
    { _tag: "TextDelta", text: "a" },
    { _tag: "TextDelta", text: "b" },
    { _tag: "TextDelta", text: "c" },
    { _tag: "Finish", reason: "stop" },
  ]);
});

Deno.test("parseResponsesSSE: comment lines (starting with colon) are ignored", async () => {
  // SSE comments ("lines starting with a colon") are control traffic and
  // must be skipped, not parsed as data.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `: keep-alive\n\ndata: ${
            JSON.stringify({ type: "response.output_text.delta", delta: "ok" })
          }\n\ndata: [DONE]\n\n`,
        ),
      );
      controller.close();
    },
  });
  const out: StreamEvent[] = [];
  for await (
    const e of parseResponsesSSE(stream, new AbortController().signal)
  ) {
    out.push(e);
  }
  assertEquals(out, [
    { _tag: "TextDelta", text: "ok" },
    { _tag: "Finish", reason: "stop" },
  ]);
});

Deno.test("parseResponsesSSE: tool_calls wins over incomplete/max_output_tokens", async () => {
  // The contract says tool_calls wins over stop. When the response is
  // incomplete AND a tool call was emitted, the reason is tool_calls (the
  // turn structurally finished on a tool call regardless of why the server
  // terminated the stream).
  const events = await collect(
    evt("response.output_item.done", {
      item: {
        type: "function_call",
        call_id: "c1",
        name: "n1",
        arguments: "{}",
      },
    }),
    evt("response.incomplete", {
      response: {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      },
    }),
  );
  assertEquals(events, [
    { _tag: "ToolCall", id: "c1", name: "n1", arguments: "{}" },
    {
      _tag: "Finish",
      reason: "tool_calls",
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    },
  ]);
});

Deno.test("parseResponsesSSE: chunked delivery across reader.read() boundaries", async () => {
  // The SSE parser must handle a single event split across multiple reads
  // (the wire is over a TCP stream and the underlying transport may yield
  // mid-line). Build a stream that yields the JSON in three pieces.
  const encoder = new TextEncoder();
  const json = JSON.stringify({
    type: "response.output_text.delta",
    delta: "split",
  });
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("data: "));
      controller.enqueue(encoder.encode(json.slice(0, 25)));
      controller.enqueue(
        encoder.encode(json.slice(25) + "\n\ndata: [DONE]\n\n"),
      );
      controller.close();
    },
  });
  const out: StreamEvent[] = [];
  for await (
    const e of parseResponsesSSE(stream, new AbortController().signal)
  ) {
    out.push(e);
  }
  assertEquals(out, [
    { _tag: "TextDelta", text: "split" },
    { _tag: "Finish", reason: "stop" },
  ]);
});

Deno.test("parseResponsesSSE: response.failed throws InvalidResponse (server-side failure is not masked as a clean stop)", async () => {
  // Without a dedicated arm, response.failed would fall through to the
  // default skip and the parser would synthesize a Finish{reason:"stop"} at
  // end-of-stream — silently converting a failed turn into an apparently
  // successful one. The arm must surface the failure through the same
  // InvalidResponse channel malformed JSON uses.
  await assertRejects(
    () =>
      drain(
        sse(evt("response.failed", {
          response: {
            status: "failed",
            error: { code: "server_error", message: "internal failure" },
          },
        })),
      ),
    InvalidResponse,
    "internal failure",
  );
});

Deno.test("parseResponsesSSE: response.failed without an error payload still throws with a fallback message", async () => {
  // A failed event with no error.code/message must still throw (never mask);
  // the fallback string keeps the message non-empty for logs/diagnostics.
  await assertRejects(
    () =>
      drain(sse(evt("response.failed", { response: { status: "failed" } }))),
    InvalidResponse,
    "unknown error",
  );
});

Deno.test("parseResponsesSSE: response.failed surfaces the error.code when message is absent", async () => {
  await assertRejects(
    () =>
      drain(
        sse(evt("response.failed", {
          response: { status: "failed", error: { code: "rate_limited" } },
        })),
      ),
    InvalidResponse,
    "rate_limited",
  );
});

Deno.test("parseResponsesSSE: usage breakdown is preserved when only reasoning_tokens is reported", async () => {
  // Some Responses completions report only the reasoning_tokens breakdown.
  // Missing primary counts remain unknown rather than becoming fake zeroes.
  const events = await collect(
    evt("response.completed", {
      response: {
        status: "completed",
        usage: { output_tokens_details: { reasoning_tokens: 7 } },
      },
    }),
  );
  assertEquals(events, [
    {
      _tag: "Finish",
      reason: "stop",
      usage: {
        reasoningTokens: 7,
      },
    },
  ]);
});
