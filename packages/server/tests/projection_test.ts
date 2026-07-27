import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { Effect } from "effect";
import type { RecordedEvent } from "@niuma/schema";
import { makeEventLog } from "../src/event_log.ts";
import { makeKernel } from "../src/kernel.ts";
import { ensureSchema } from "../src/projection.ts";

Deno.test("server projection tracks lifecycle and keeps the first typed user title", async () => {
  const root = await Deno.makeTempDir({ prefix: "niuma_projection_" });
  const projection = await ensureSchema(join(root, "niuma.db"));
  const sessionId = "projection";
  const events: RecordedEvent[] = [
    {
      seq: 1,
      ts: 1,
      sessionId,
      type: "session.created",
      data: { workspace: root, model: "test-model", mcpServers: [] },
    },
    {
      seq: 2,
      ts: 2,
      sessionId,
      type: "turn.started",
      data: {},
    },
    {
      seq: 3,
      ts: 3,
      sessionId,
      type: "user.message",
      data: {
        parts: [{ type: "text", text: "expanded command body" }],
        sourceText: "/review src/main.ts",
      },
    },
    {
      seq: 4,
      ts: 4,
      sessionId,
      type: "user.message",
      data: { parts: [{ type: "text", text: "second prompt" }] },
    },
    {
      seq: 5,
      ts: 5,
      sessionId,
      type: "turn.completed",
      data: {
        stopReason: "stop",
        usage: { inputTokens: 4, outputTokens: 2 },
      },
    },
  ];
  for (const event of events) await projection.apply(event);

  const info = await projection.getSession(sessionId);
  assertExists(info);
  assertEquals(info.title, "/review src/main.ts");
  assertEquals(info.status, "idle");
  assertEquals(info.lastStopReason, "stop");
  assertEquals(info.updatedAt, 5);
  projection.close();
});

Deno.test("Kernel sequence resumes monotonically after reopening the server", async () => {
  const root = await Deno.makeTempDir({ prefix: "niuma_sequence_" });
  const sessions = join(root, "sessions");
  await Deno.mkdir(sessions, { recursive: true });
  const dbPath = join(root, "niuma.db");
  const eventLog = makeEventLog({ sessionsDir: sessions });

  const firstProjection = await ensureSchema(dbPath);
  const firstKernel = await Effect.runPromise(makeKernel({
    event_log: eventLog,
    projection: firstProjection,
  }));
  const created = await Effect.runPromise(firstKernel.append({
    type: "session.created",
    sessionId: "sequence",
    data: { workspace: root, model: "test-model", mcpServers: [] },
  }));
  const message = await Effect.runPromise(firstKernel.append({
    type: "user.message",
    sessionId: "sequence",
    data: { parts: [{ type: "text", text: "hello" }] },
  }));
  assertEquals([created.seq, message.seq], [1, 2]);
  firstProjection.close();

  const secondProjection = await ensureSchema(dbPath);
  const secondKernel = await Effect.runPromise(makeKernel({
    event_log: eventLog,
    projection: secondProjection,
  }));
  const next = await Effect.runPromise(secondKernel.append({
    type: "turn.started",
    sessionId: "sequence",
    data: {},
  }));
  assertEquals(next.seq, 3);

  const replayed: RecordedEvent[] = [];
  for await (const event of eventLog.replay("sequence")) replayed.push(event);
  assertEquals(replayed.map((event) => event.seq), [1, 2, 3]);
  secondProjection.close();
});
