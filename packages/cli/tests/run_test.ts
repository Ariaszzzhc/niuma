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
        stopReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
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
