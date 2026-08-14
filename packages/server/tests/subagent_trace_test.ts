import { assertEquals } from "@std/assert";
import type { RecordedEvent } from "@niuma/schema";
import {
  buildSubagentTrace,
  lastCompletedUsage,
} from "../src/subagent_trace.ts";

const ev = (type: string, data: unknown, seq = 1): RecordedEvent =>
  ({ seq, ts: seq, sessionId: "child", type, data }) as RecordedEvent;

Deno.test("buildSubagentTrace: chronological lines, skips scaffolding, truncates per item", () => {
  const events: RecordedEvent[] = [
    ev("session.created", { workspace: "/w", model: "m", mcpServers: [] }),
    ev("user.message", { parts: [{ type: "text", text: "the prompt" }] }),
    ev("assistant.message", {
      parts: [{ type: "text", text: "checking files" }],
    }),
    ev("tool.call.requested", {
      callId: "c1",
      name: "bash",
      input: { command: "ls" },
    }, 4),
    ev("tool.result", {
      callId: "c1",
      content: "x".repeat(3000),
      isError: false,
      durationMs: 5,
    }, 5),
    ev("error.occurred", { message: "boom", retryable: false }, 6),
  ];
  const trace = buildSubagentTrace(events);
  assertEquals(trace.includes("session.created"), false);
  assertEquals(trace.includes("the prompt"), false);
  assertEquals(trace.includes("assistant: checking files"), true);
  assertEquals(trace.includes('tool call: bash {"command":"ls"}'), true);
  const resultLine = trace.split("\n").find((l) => l.startsWith("tool result"));
  assertEquals(resultLine?.includes("x".repeat(2048)), true);
  assertEquals((resultLine?.length ?? 0) <= 2100, true);
  assertEquals(trace.includes("error: boom"), true);
});

Deno.test("buildSubagentTrace: total cap and empty input", () => {
  const events: RecordedEvent[] = Array.from(
    { length: 10 },
    (_, i) =>
      ev("assistant.message", {
        parts: [{ type: "text", text: `msg ${i} ${"y".repeat(1024)}` }],
      }, i + 1),
  );
  const trace = buildSubagentTrace(events);
  assertEquals(trace.length <= 10 * 1024, true);
  assertEquals(buildSubagentTrace([]), "");
});

Deno.test("lastCompletedUsage: last model call wins, null when absent", () => {
  const usage = {
    inputTokens: 1,
    outputTokens: 2,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
  };
  const events: RecordedEvent[] = [
    ev("model.call.completed", {
      callId: "a",
      turnId: "t",
      purpose: "agent",
      actor: "subagent",
      providerId: "p",
      modelId: "m",
      billingMode: "unknown",
      durationMs: 1,
      attempts: 1,
      finishReason: "stop",
      usage,
    }, 1),
    ev("model.call.completed", {
      callId: "b",
      turnId: "t",
      purpose: "agent",
      actor: "subagent",
      providerId: "p",
      modelId: "m",
      billingMode: "unknown",
      durationMs: 1,
      attempts: 1,
      finishReason: "stop",
      usage: { ...usage, inputTokens: 9 },
    }, 2),
  ];
  assertEquals(lastCompletedUsage(events), { inputTokens: 9, outputTokens: 2 });
  assertEquals(lastCompletedUsage([]), null);
});
