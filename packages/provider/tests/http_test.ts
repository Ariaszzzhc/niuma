import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { niumaFetch } from "../src/http.ts";
import { VERSION } from "@niuma/config";

// niumaFetch always passes headers as a plain object, so the mock can record it
// as-is; the cast just satisfies the union-typed init param.
const headerMap = (init: unknown): Record<string, string> =>
  ((init as RequestInit | undefined)?.headers ?? {}) as Record<string, string>;

Deno.test("niumaFetch stamps user-agent niuma/<version> on every request", async () => {
  let captured: Record<string, string> | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_input, init) => {
    captured = headerMap(init);
    return Promise.resolve(new Response("ok", { status: 200 }));
  };
  try {
    await niumaFetch("https://example.test", {});
  } finally {
    globalThis.fetch = originalFetch;
  }
  assertEquals(captured?.["user-agent"], `niuma/${VERSION}`);
});

Deno.test("niumaFetch preserves caller headers and forces the niuma user-agent", async () => {
  let captured: Record<string, string> | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_input, init) => {
    captured = headerMap(init);
    return Promise.resolve(new Response("ok", { status: 200 }));
  };
  try {
    await niumaFetch("https://example.test", {
      headers: {
        "x-api-key": "k",
        authorization: "Bearer t",
        "user-agent": "should-be-overwritten",
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assertEquals(captured?.["x-api-key"], "k");
  assertEquals(captured?.["authorization"], "Bearer t");
  assertEquals(captured?.["user-agent"], `niuma/${VERSION}`);
});
