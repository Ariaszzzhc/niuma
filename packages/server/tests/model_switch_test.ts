import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { Effect, Stream } from "effect";
import type {
  ChatRequest,
  ProviderAdapter,
  StreamEvent,
} from "@niuma/provider";
import { type NiumaConfig, parseConfig } from "@niuma/config";
import { createServerApp } from "../mod.ts";
import { bootstrap } from "../src/bootstrap.ts";
import { dataPaths } from "../src/paths.ts";

// Runtime model/effort switching: POST /sessions/:id/model and
// /sessions/:id/effort reroute the session's NEXT turn — the model id lands
// in Session State, per-model limits + thinking + a rebuilt adapter (on
// cross-provider switches) live in the SessionManager's in-memory overrides.

const CONFIG_TOML = `
model = "p1/model-a"

[provider.p1]
base_url = "http://p1.invalid"
api_key = "k1"

[provider.p1.models.model-a]
context_window = 100000
max_output = 4096

[provider.p1.models.model-b]
context_window = 50000
max_output = 2048
thinking_effort = "low"

[provider.p2]
base_url = "http://p2.invalid"
api_key = "k2"

[provider.p2.models.model-c]
context_window = 64000
max_output = 8192
`;

// A network-free provider that records every ChatRequest it sees and
// immediately finishes the turn.
const makeCaptureProvider = (sink: ChatRequest[]): ProviderAdapter => ({
  listModels: () => Effect.succeed([]),
  stream: (req): Stream.Stream<StreamEvent> => {
    sink.push(req);
    return Stream.fromIterable([
      { _tag: "TextDelta", text: "ok" } as StreamEvent,
      {
        _tag: "Finish",
        reason: "stop",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      } as StreamEvent,
    ]);
  },
});

interface Fixture {
  readonly root: string;
  readonly workspace: string;
}

const makeFixture = async (): Promise<Fixture> => {
  const root = await Deno.makeTempDir({ prefix: "niuma_model_" });
  const workspace = join(root, "ws");
  await Deno.mkdir(workspace, { recursive: true });
  return { root, workspace };
};

interface BuildOptions {
  readonly provider: ProviderAdapter;
  readonly makeProvider?: (
    config: NiumaConfig,
    ref: string,
  ) => Promise<ProviderAdapter>;
}

const buildApp = async (f: Fixture, opts: BuildOptions) => {
  const boot = await bootstrap({
    paths: dataPaths(f.root, f.workspace),
    config: parseConfig(CONFIG_TOML),
    infra: {
      provider: opts.provider,
      ...(opts.makeProvider !== undefined
        ? { makeProvider: opts.makeProvider }
        : {}),
    },
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
  const body = await res.json();
  return body.sessionId as string;
};

const post = async (
  app: App,
  path: string,
  body: unknown,
): Promise<Response> =>
  await app.fetch(
    new Request(`http://niuma.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

interface HistoryEvent {
  type: string;
}

// The prompt handler forks the turn on a background fiber — poll the history
// until turn.completed shows up.
const waitForTurnCompleted = async (
  app: App,
  sessionId: string,
): Promise<void> => {
  for (let i = 0; i < 50; i++) {
    const res = await app.fetch(
      new Request(`http://niuma.internal/sessions/${sessionId}/history`),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    if (
      (body.events as HistoryEvent[]).some((e) => e.type === "turn.completed")
    ) {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("turn.completed never appeared in history");
};

Deno.test({
  name: "setModel with a bare model-id applies model + limits to the next turn",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const f = await makeFixture();
    const sink: ChatRequest[] = [];
    const { app } = await buildApp(f, { provider: makeCaptureProvider(sink) });
    const sessionId = await createSession(app, f);

    const res = await post(app, `/sessions/${sessionId}/model`, {
      model: "model-b",
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.ok, true);
    assertEquals(body.model, "p1/model-b");
    assertEquals(body.contextWindow, 50000);

    // Folded Session State carries the canonical provider/model ref.
    const info = await (await app.fetch(
      new Request(`http://niuma.internal/sessions/${sessionId}`),
    )).json();
    assertEquals(info.info.model, "p1/model-b");

    const promptRes = await post(app, `/sessions/${sessionId}/prompt`, {
      text: "hello",
    });
    assertEquals(promptRes.status, 202);
    await waitForTurnCompleted(app, sessionId);

    assertEquals(sink.length, 1);
    assertEquals(sink[0].model, "model-b");
    assertEquals(sink[0].maxTokens, 2048);
    assertEquals(sink[0].thinking, { effort: "low" });
  },
});

Deno.test({
  name: "setEffort flows into the turn's thinking config (merged over keep)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const f = await makeFixture();
    const sink: ChatRequest[] = [];
    const { app } = await buildApp(f, { provider: makeCaptureProvider(sink) });
    const sessionId = await createSession(app, f);

    const res = await post(app, `/sessions/${sessionId}/effort`, {
      effort: "high",
    });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: true, effort: "high" });

    // model-a declares no thinking config, so the override stands alone.
    const promptRes = await post(app, `/sessions/${sessionId}/prompt`, {
      text: "hello",
    });
    assertEquals(promptRes.status, 202);
    await waitForTurnCompleted(app, sessionId);

    assertEquals(sink.length, 1);
    assertEquals(sink[0].model, "model-a");
    assertEquals(sink[0].thinking, { effort: "high" });
  },
});

Deno.test({
  name: "cross-provider setModel rebuilds the adapter via the factory",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const f = await makeFixture();
    const sinkA: ChatRequest[] = [];
    const sinkB: ChatRequest[] = [];
    const factoryCalls: string[] = [];
    const { app } = await buildApp(f, {
      provider: makeCaptureProvider(sinkA),
      makeProvider: (_config, ref) => {
        factoryCalls.push(ref);
        return Promise.resolve(makeCaptureProvider(sinkB));
      },
    });
    const sessionId = await createSession(app, f);

    const res = await post(app, `/sessions/${sessionId}/model`, {
      model: "p2/model-c",
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.ok, true);
    assertEquals(body.model, "p2/model-c");
    assertEquals(body.contextWindow, 64000);
    assertEquals(factoryCalls, ["p2/model-c"]);

    const promptRes = await post(app, `/sessions/${sessionId}/prompt`, {
      text: "hello",
    });
    assertEquals(promptRes.status, 202);
    await waitForTurnCompleted(app, sessionId);

    // The rebuilt adapter served the turn; the boot adapter saw nothing.
    assertEquals(sinkA.length, 0);
    assertEquals(sinkB.length, 1);
    assertEquals(sinkB[0].model, "model-c");
    assertEquals(sinkB[0].maxTokens, 8192);
  },
});

Deno.test({
  name: "setModel/setEffort on a missing session return session_not_found",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const f = await makeFixture();
    const { app } = await buildApp(f, {
      provider: makeCaptureProvider([]),
    });

    const modelRes = await post(app, "/sessions/deadbeef/model", {
      model: "p1/model-b",
    });
    assertEquals(modelRes.status, 404);
    assertEquals((await modelRes.json()).error.code, "session_not_found");

    const effortRes = await post(app, "/sessions/deadbeef/effort", {
      effort: "high",
    });
    assertEquals(effortRes.status, 404);
    assertEquals((await effortRes.json()).error.code, "session_not_found");
  },
});

Deno.test({
  name: "setModel rejects an unconfigured provider ref",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const f = await makeFixture();
    const { app } = await buildApp(f, {
      provider: makeCaptureProvider([]),
    });
    const sessionId = await createSession(app, f);

    const res = await post(app, `/sessions/${sessionId}/model`, {
      model: "nope/model-x",
    });
    assert(res.status >= 400);
    assertEquals((await res.json()).error.code, "set_model_failed");
  },
});
