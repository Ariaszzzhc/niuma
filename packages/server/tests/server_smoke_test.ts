import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createServerApp } from "../mod.ts";
import { bootstrap } from "../src/bootstrap.ts";
import { makeEventLog } from "../src/event_log.ts";
import { ensureSchema } from "../src/projection.ts";
import { makeEventBus } from "../src/event_bus.ts";
import { makeMockProvider } from "@niuma/provider";
import { parseConfig } from "@niuma/config";
import { Effect } from "effect";

// Use a temp data dir so the smoke test never touches ~/.niuma.
const TMP_DIR = await Deno.makeTempDir({ prefix: "niuma_smoke_" });
const sessionsDir = join(TMP_DIR, "sessions");
const dbPath = join(TMP_DIR, "niuma.db");
await Deno.mkdir(sessionsDir, { recursive: true });

async function buildApp() {
  const bus = await Effect.runPromise(makeEventBus());
  const event_log = makeEventLog({ sessionsDir });
  const projection = await ensureSchema(dbPath);
  const boot = await bootstrap({
    paths: {
      root: TMP_DIR,
      sessions: sessionsDir,
      db: dbPath,
    },
    event_log,
    projection,
    bus,
    // Inject the network-free provider and an in-memory config so the test
    // never reads config.toml / auth.json / the real backend.
    config: parseConfig(""),
    infra: { provider: makeMockProvider() },
  });
  return await createServerApp({ bootstrap: boot });
}

Deno.test({
  name: "GET /health returns 200 and the server version",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { app } = await buildApp();
    const res = await app.fetch(new Request("http://niuma.internal/health"));
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.ok, true);
    assert(typeof body.version === "string");
  },
});

Deno.test({
  name: "POST /sessions creates a session and GET /sessions lists it",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { app } = await buildApp();
    const create = await app.fetch(
      new Request("http://niuma.internal/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace: "/tmp", model: "smoke-model" }),
      }),
    );
    assertEquals(create.status, 201);
    const created = await create.json();
    assert(typeof created.sessionId === "string");
    assertEquals(created.workspace, "/tmp");
    assertEquals(created.model, "smoke-model");

    const listRes = await app.fetch(
      new Request("http://niuma.internal/sessions"),
    );
    assertEquals(listRes.status, 200);
    const list = await listRes.json();
    assert(Array.isArray(list));
    assert(
      list.some((s: { sessionId: string }) =>
        s.sessionId === created.sessionId
      ),
    );
  },
});

Deno.test({
  name: "POST /sessions/:id/prompt with {text} returns 202",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { app } = await buildApp();
    const create = await app.fetch(
      new Request("http://niuma.internal/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace: "/tmp", model: "smoke-model" }),
      }),
    );
    const { sessionId } = await create.json();

    const promptRes = await app.fetch(
      new Request(`http://niuma.internal/sessions/${sessionId}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      }),
    );
    assertEquals(promptRes.status, 202);
    const body = await promptRes.json();
    assertEquals(body.accepted, true);
  },
});

Deno.test({
  name: "GET /sessions/:id/history replays recorded events",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { app } = await buildApp();
    const create = await app.fetch(
      new Request("http://niuma.internal/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace: "/tmp", model: "smoke-model" }),
      }),
    );
    const { sessionId } = await create.json();
    const res = await app.fetch(
      new Request(`http://niuma.internal/sessions/${sessionId}/history`),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assert(Array.isArray(body.events));
    assert(body.events.length >= 1);
    assertEquals(body.events[0].type, "session.created");
  },
});

Deno.test({
  name: "unknown route returns 404 JSON",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { app } = await buildApp();
    const res = await app.fetch(new Request("http://niuma.internal/nope"));
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.error.code, "not_found");
  },
});

Deno.test({
  name: "GET /events streams replayed events as SSE id/event/data frames",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { app, kernel } = await buildApp();
    const { Effect } = await import("effect");
    // Seed a session + a user.message event directly through the kernel so
    // /events has something to replay.
    await Effect.runPromise(kernel.append({
      type: "session.created",
      sessionId: "sse_smoke",
      data: { workspace: "/tmp", model: "smoke-model", mcpServers: [] },
    }));
    await Effect.runPromise(kernel.append({
      type: "user.message",
      sessionId: "sse_smoke",
      data: { parts: [{ type: "text" as const, text: "hi" }] },
    }));

    const res = await app.fetch(
      new Request("http://niuma.internal/events?session=sse_smoke"),
    );
    assertEquals(res.status, 200);
    const ct = res.headers.get("content-type") ?? "";
    assert(ct.startsWith("text/event-stream"), `got ${ct}`);
    assert(res.body, "expected a streaming body");

    // Decode the first chunk and verify it carries the session.created frame.
    const reader = res.body.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    assert(value, "expected at least one chunk");
    const text = new TextDecoder().decode(value);
    assert(
      text.includes("event: session.created"),
      `got: ${text.slice(0, 200)}`,
    );
    assert(
      text.includes("id: 1"),
      `expected id:1 frame, got: ${text.slice(0, 200)}`,
    );
    assert(
      text.includes("data: "),
      `expected data: line, got: ${text.slice(0, 200)}`,
    );
  },
});

Deno.test({
  name: "GET /events preserves live events across the replay handoff",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { app, kernel } = await buildApp();
    const { Effect } = await import("effect");
    // One recorded event so the session exists and replay has something to
    // drain before the live tail takes over.
    await Effect.runPromise(kernel.append({
      type: "session.created",
      sessionId: "sse_live",
      data: { workspace: "/tmp", model: "smoke-model", mcpServers: [] },
    }));

    const res = await app.fetch(
      new Request("http://niuma.internal/events?session=sse_live"),
    );
    assertEquals(res.status, 200);
    assert(res.body, "expected a streaming body");
    const reader = res.body.getReader();

    // Read until the replayed session.created frame arrives — that proves the
    // handler has drained the JSONL and flipped to the live tail.
    const readLine = async (): Promise<string> => {
      const { value, done } = await reader.read();
      assert(!done && value, "stream ended before the expected frame");
      return new TextDecoder().decode(value);
    };
    let chunk = await readLine();
    for (let i = 0; i < 20 && !chunk.includes("session.created"); i++) {
      chunk += await readLine();
    }
    assert(
      chunk.includes("session.created"),
      `replay frame never arrived: ${chunk.slice(0, 200)}`,
    );

    // The subscription is acquired before replay, so publishing immediately
    // after observing the replay frame must still reach this response.
    await Effect.runPromise(kernel.live({
      type: "text.delta",
      ts: Date.now(),
      sessionId: "sse_live",
      data: { delta: "hello-live" },
    }));

    let liveChunk = await readLine();
    for (let i = 0; i < 20 && !liveChunk.includes("text.delta"); i++) {
      liveChunk += await readLine();
    }
    await reader.cancel();
    assert(
      liveChunk.includes("event: text.delta"),
      `live text.delta never arrived on the SSE stream: ${
        liveChunk.slice(0, 200)
      }`,
    );
    assert(
      liveChunk.includes("hello-live"),
      `live frame missing the delta payload: ${liveChunk.slice(0, 200)}`,
    );
  },
});
