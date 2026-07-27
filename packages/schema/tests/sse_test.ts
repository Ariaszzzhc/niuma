import { assertEquals } from "@std/assert";
import { parseSseStream } from "../mod.ts";

const chunked = (...chunks: string[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

Deno.test("parseSseStream handles split CRLF frames and multiline data", async () => {
  const frames = [];
  for await (
    const frame of parseSseStream(
      chunked(
        "id: 7\r\nevent: text.delta\r\nda",
        "ta: first\r\ndata: second\r\n\r\n",
      ),
    )
  ) {
    frames.push(frame);
  }
  assertEquals(frames, [{
    id: "7",
    event: "text.delta",
    data: "first\nsecond",
  }]);
});

Deno.test("parseSseStream flushes an unterminated final frame", async () => {
  const frames = [];
  for await (
    const frame of parseSseStream(chunked(": comment\n", "data: final"))
  ) {
    frames.push(frame);
  }
  assertEquals(frames, [{ data: "final" }]);
});
