import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { Effect, Stream } from "effect";
import type { ProviderAdapter, StreamEvent } from "@niuma/provider";
import { parseConfig } from "@niuma/config";
import { createServerApp } from "../mod.ts";
import { bootstrap } from "../src/bootstrap.ts";
import { dataPaths } from "../src/paths.ts";
import type { Kernel } from "../src/kernel.ts";

// POST /sessions/:id/compact — the /compact command endpoint. The handler
// forks compactSession (@niuma/agent) on a background fiber: it replays the
// Session Journal, summarizes the history (LLM, template fallback), and
// summary-bearing compaction.performed event. Too-short histories record
// nothing; a session with a turn in flight is refused with 409
// turn_in_flight.

interface Fixture {
  readonly root: string;
  readonly workspace: string;
}

const makeFixture = async (): Promise<Fixture> => {
  const root = await Deno.makeTempDir({ prefix: "niuma_compact_" });
  const workspace = join(root, "ws");
  await Deno.mkdir(workspace, { recursive: true });
  return { root, workspace };
};

const FINISH: StreamEvent = {
  _tag: "Finish",
  reason: "stop",
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
} as StreamEvent;

// A network-free provider that answers every call (turns AND the summarizer)
// with a fixed text and finishes immediately.
const makeSummaryProvider = (text: string): ProviderAdapter => ({
  listModels: () => Effect.succeed([]),
  stream: (): Stream.Stream<StreamEvent> =>
    Stream.fromIterable([
      { _tag: "TextDelta", text } as StreamEvent,
      FINISH,
    ]),
});

// A provider whose stream blocks until `gate` resolves — keeps a turn in
// flight for as long as the test needs. `called` flips once runTurn has
// actually entered the stream (i.e. the turn is occupying the session).
const makeBlockingProvider = (
  gate: Promise<void>,
  called: { value: boolean },
): ProviderAdapter => ({
  listModels: () => Effect.succeed([]),
  stream: (): Stream.Stream<StreamEvent> => {
    called.value = true;
    return Stream.unwrap(
      Effect.promise(() => gate).pipe(
        Effect.map(() =>
          Stream.fromIterable([
            { _tag: "TextDelta", text: "done" } as StreamEvent,
            FINISH,
          ])
        ),
      ),
    );
  },
});

const buildApp = async (f: Fixture, provider: ProviderAdapter) => {
  const boot = await bootstrap({
    paths: dataPaths(f.root, f.workspace),
    config: parseConfig(""),
    infra: { provider },
  });
  return await createServerApp({ bootstrap: boot });
};

type App = { fetch: (req: Request) => Response | Promise<Response> };

const createSession = async (app: App, _f: Fixture): Promise<string> => {
  const res = await app.fetch(
    new Request("http://niuma.internal/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "model-a" }),
    }),
  );
  assertEquals(res.status, 201);
  return (await res.json()).sessionId as string;
};

const postCompact = async (app: App, sessionId: string): Promise<Response> =>
  await app.fetch(
    new Request(`http://niuma.internal/sessions/${sessionId}/compact`, {
      method: "POST",
    }),
  );

interface HistoryEvent {
  type: string;
  data?: {
    summary?: string;
    mode?: string;
  };
}

const history = async (
  app: App,
  sessionId: string,
): Promise<HistoryEvent[]> => {
  const res = await app.fetch(
    new Request(`http://niuma.internal/sessions/${sessionId}/history`),
  );
  assertEquals(res.status, 200);
  return (await res.json()).events as HistoryEvent[];
};

// Compaction runs on a background fiber — poll the history until the event
// shows up.
const waitForCompaction = async (
  app: App,
  sessionId: string,
): Promise<HistoryEvent> => {
  for (let i = 0; i < 50; i++) {
    const ev = (await history(app, sessionId)).find(
      (e) => e.type === "compaction.performed",
    );
    if (ev) return ev;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("compaction.performed never appeared in history");
};

// Append one user/assistant round straight to the Journal, bypassing the
// agent loop (the compaction path only reads the log).
const appendRound = async (
  kernel: Kernel,
  sessionId: string,
  i: number,
): Promise<void> => {
  await Effect.runPromise(
    kernel.append({
      type: "user.message",
      sessionId,
      data: { parts: [{ type: "text", text: `question ${i}` }] },
    }),
  );
  await Effect.runPromise(
    kernel.append({
      type: "assistant.message",
      sessionId,
      data: {
        parts: [{ type: "text", text: `answer ${i}` }],
      },
    }),
  );
};

Deno.test({
  name: "POST compact compacts a multi-turn session and records the summary",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const f = await makeFixture();
    const { app, kernel } = await buildApp(f, makeSummaryProvider("handoff"));
    const sessionId = await createSession(app, f);
    // compactSession keeps the last 2 user turns — 3 rounds leaves a prefix
    // worth folding.
    for (let i = 1; i <= 3; i++) await appendRound(kernel, sessionId, i);

    const res = await postCompact(app, sessionId);
    assertEquals(res.status, 202);
    assertEquals(await res.json(), { accepted: true });

    const ev = await waitForCompaction(app, sessionId);
    assertEquals(ev.data?.mode, "llm");
    assert(ev.data?.summary?.includes("handoff"));
  },
});

Deno.test({
  name: "POST compact on a short history accepts but records nothing",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const f = await makeFixture();
    const { app, kernel } = await buildApp(f, makeSummaryProvider("handoff"));
    const sessionId = await createSession(app, f);
    await appendRound(kernel, sessionId, 1);

    const res = await postCompact(app, sessionId);
    assertEquals(res.status, 202);

    // Give the background fiber ample time, then assert the no-op guard held.
    await new Promise((r) => setTimeout(r, 500));
    const events = await history(app, sessionId);
    assertEquals(
      events.some((e) => e.type === "compaction.performed"),
      false,
    );
  },
});

Deno.test({
  name: "POST compact while a turn is in flight returns 409 turn_in_flight",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const f = await makeFixture();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const called = { value: false };
    const { app } = await buildApp(f, makeBlockingProvider(gate, called));
    const sessionId = await createSession(app, f);

    const promptRes = await app.fetch(
      new Request(`http://niuma.internal/sessions/${sessionId}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      }),
    );
    assertEquals(promptRes.status, 202);
    // Wait until the turn is actually blocked inside the provider stream.
    for (let i = 0; i < 50 && !called.value; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert(called.value, "turn never entered the provider stream");

    const busy = await postCompact(app, sessionId);
    assertEquals(busy.status, 409);
    assertEquals((await busy.json()).error.code, "turn_in_flight");

    // Let the turn finish; the session then accepts compaction again.
    release();
    for (let i = 0; i < 50; i++) {
      const events = await history(app, sessionId);
      if (events.some((e) => e.type === "turn.completed")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const after = await postCompact(app, sessionId);
    assertEquals(after.status, 202);
    assertEquals(await after.json(), { accepted: true });
  },
});

Deno.test({
  name: "POST compact on a missing session returns session_not_found",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const f = await makeFixture();
    const { app } = await buildApp(f, makeSummaryProvider("handoff"));

    const res = await postCompact(app, "deadbeef");
    assertEquals(res.status, 404);
    assertEquals((await res.json()).error.code, "session_not_found");
  },
});
