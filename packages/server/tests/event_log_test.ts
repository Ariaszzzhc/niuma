import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { parseConfig } from "@niuma/config";
import { makeMockProvider } from "@niuma/provider";
import { type RecordedEvent, stringifyEventLine } from "@niuma/schema";
import { createServerApp } from "../src/app.ts";
import { bootstrap } from "../src/bootstrap.ts";
import { CorruptSessionError, makeEventLog } from "../src/event_log.ts";
import { ensureSchema } from "../src/projection.ts";

const createdEvent = (
  sessionId: string,
  root: string,
): RecordedEvent => ({
  seq: 1,
  ts: 1,
  sessionId,
  type: "session.created",
  data: { workspace: root, model: "test-model", mcpServers: [] },
});

Deno.test("replay deletes an entire log before yielding when any line is malformed", async () => {
  const root = await Deno.makeTempDir({ prefix: "niuma_corrupt_log_" });
  const sessions = join(root, "sessions");
  await Deno.mkdir(sessions, { recursive: true });
  const sessionId = "malformed";
  const path = join(sessions, `${sessionId}.jsonl`);
  const event = createdEvent(sessionId, root);
  await Deno.writeTextFile(
    path,
    `${stringifyEventLine(event)}\n{not-json}\n`,
  );

  const removed: string[] = [];
  const eventLog = makeEventLog({
    sessionsDir: sessions,
    onCorrupt: (id) => {
      removed.push(id);
      return Promise.resolve();
    },
  });
  const replayed: RecordedEvent[] = [];
  const error = await assertRejects(
    async () => {
      for await (const item of eventLog.replay(sessionId)) replayed.push(item);
    },
    CorruptSessionError,
  );

  assertEquals(error.sessionId, sessionId);
  assertEquals(replayed, []);
  assertEquals(removed, [sessionId]);
  await assertRejects(() => Deno.stat(path), Deno.errors.NotFound);
});

Deno.test("lastSeq deletes a log with a truncated final line", async () => {
  const root = await Deno.makeTempDir({ prefix: "niuma_truncated_log_" });
  const sessions = join(root, "sessions");
  await Deno.mkdir(sessions, { recursive: true });
  const sessionId = "truncated";
  const path = join(sessions, `${sessionId}.jsonl`);
  await Deno.writeTextFile(
    path,
    `${stringifyEventLine(createdEvent(sessionId, root))}\n{"seq":`,
  );

  const eventLog = makeEventLog({ sessionsDir: sessions });
  await assertRejects(
    () => eventLog.lastSeq(sessionId),
    CorruptSessionError,
  );
  await assertRejects(() => Deno.stat(path), Deno.errors.NotFound);
});

Deno.test({
  name: "bootstrap purges a corrupted session and prompt cannot recreate it",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const root = await Deno.makeTempDir({ prefix: "niuma_corrupt_boot_" });
    const sessions = join(root, "sessions");
    const workspace = join(root, "workspace");
    const db = join(root, "niuma.db");
    await Deno.mkdir(sessions, { recursive: true });
    await Deno.mkdir(workspace, { recursive: true });

    const sessionId = "corrupted";
    const event = createdEvent(sessionId, workspace);
    const projection = await ensureSchema(db);
    await projection.apply(event);
    const path = join(sessions, `${sessionId}.jsonl`);
    await Deno.writeTextFile(
      path,
      `${stringifyEventLine(event)}\ninvalid\n`,
    );

    const boot = await bootstrap({
      paths: { root, sessions, db },
      projection,
      config: parseConfig(""),
      infra: { provider: makeMockProvider() },
    });
    assertEquals(await projection.getSession(sessionId), undefined);
    await assertRejects(() => Deno.stat(path), Deno.errors.NotFound);

    const { app } = await createServerApp({ bootstrap: boot });
    const response = await app.fetch(
      new Request(
        `http://niuma.internal/sessions/${sessionId}/prompt`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "do not revive" }),
        },
      ),
    );
    assertEquals(response.status, 404);
    assertEquals((await response.json()).error.code, "session_not_found");
    await assertRejects(() => Deno.stat(path), Deno.errors.NotFound);
  },
});
