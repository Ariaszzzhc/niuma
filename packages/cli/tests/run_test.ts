// ===========================================================================
// @niuma/cli — one-shot runner tests
// ---------------------------------------------------------------------------
// Exercises the non-interactive permission path over the real SSE/HTTP client
// contract. The fake server records the approval POST so the test proves the
// runner chose "once" without reading stdin.
// ===========================================================================

import { assertEquals } from "@std/assert";
import { runOneshot } from "../src/run.ts";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const recorded = (
  seq: number,
  type: string,
  data: Record<string, unknown>,
): Record<string, unknown> => ({
  seq,
  ts: seq,
  sessionId: "s1",
  type,
  data,
});

const sseFrame = (
  cursor: number,
  event: Record<string, unknown>,
): string =>
  `id: ${cursor}\nevent: ${String(event.type)}\ndata: ${
    JSON.stringify(event)
  }\n\n`;

Deno.test("runOneshot: permission bypass auto-approves once without stdin", async () => {
  const approvalBodies: unknown[] = [];
  const events = [
    sseFrame(
      1,
      recorded(1, "approval.requested", {
        approvalId: "approval-1",
        callId: "call-1",
        name: "bash",
        input: { command: "true" },
      }),
    ),
    sseFrame(
      2,
      recorded(2, "turn.completed", {
        turnId: "turn-1",
        stopReason: "stop",
      }),
    ),
  ].join("");

  const fetchImpl: typeof fetch = (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/sessions") && method === "POST") {
      return Promise.resolve(jsonResponse({ sessionId: "s1" }));
    }
    if (url.includes("/events?")) {
      return Promise.resolve(
        new Response(events, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    }
    if (url.endsWith("/sessions/s1/prompt") && method === "POST") {
      return Promise.resolve(jsonResponse({}, 202));
    }
    if (
      url.endsWith("/sessions/s1/approvals/approval-1") &&
      method === "POST"
    ) {
      approvalBodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(jsonResponse({}));
    }
    return Promise.resolve(jsonResponse({ error: "unexpected request" }, 404));
  };

  const result = await runOneshot(
    {
      prompt: "task",
      workspace: "/workspace",
      bypassPermissions: true,
      quiet: true,
    },
    fetchImpl,
  );

  assertEquals(result.exitCode, 0);
  assertEquals(approvalBodies, [{ decision: "once" }]);
});

Deno.test("runOneshot: explicit resume reads one Session and tails after history", async () => {
  const requests: Array<{ method: string; url: string }> = [];
  const events = [
    sseFrame(
      8,
      recorded(8, "assistant.message", {
        parts: [{ type: "text", text: "continued answer" }],
      }),
    ),
    sseFrame(
      9,
      recorded(9, "turn.completed", {
        turnId: "turn-2",
        stopReason: "stop",
      }),
    ),
  ].join("");

  const fetchImpl: typeof fetch = (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ method, url });
    if (method === "GET" && url.endsWith("/sessions/s_old")) {
      return Promise.resolve(
        jsonResponse({
          info: {
            sessionId: "s_old",
            workspace: "/workspace",
            model: "openai/gpt-5",
            createdAt: 1,
            updatedAt: 7,
            status: "idle",
          },
          history: [{
            seq: 7,
            ts: 7,
            sessionId: "s_old",
            type: "turn.completed",
            data: { turnId: "turn-1", stopReason: "stop" },
          }],
          mcpServers: [],
          commands: [],
          clientConfig: { inputDelivery: "steer" },
        }),
      );
    }
    if (method === "GET" && url.includes("/events?")) {
      return Promise.resolve(
        new Response(events, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    }
    if (method === "POST" && url.endsWith("/sessions/s_old/prompt")) {
      return Promise.resolve(jsonResponse({ disposition: "started" }, 202));
    }
    return Promise.resolve(jsonResponse({ error: "unexpected request" }, 404));
  };

  const result = await runOneshot(
    {
      prompt: "continue",
      workspace: "/workspace",
      resume: "s_old",
      quiet: true,
    },
    fetchImpl,
  );

  assertEquals(result.exitCode, 0);
  assertEquals(result.sessionId, "s_old");
  assertEquals(result.finalText, "continued answer");
  assertEquals(
    requests.some((request) =>
      request.method === "POST" && request.url.endsWith("/sessions")
    ),
    false,
  );
  assertEquals(
    requests.some((request) => request.url.endsWith("cursor=8")),
    true,
  );
});
