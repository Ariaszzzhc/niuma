import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { Effect, Stream } from "effect";
import type { ChatRequest, ProviderAdapter, StreamEvent } from "@niuma/provider";
import { parseConfig } from "@niuma/config";
import { createServerApp } from "../mod.ts";
import { bootstrap } from "../src/bootstrap.ts";
import { dataPaths } from "../src/paths.ts";

// Session rename: POST /sessions/:id/title persists a session.title.changed
// event (append-only), the folded read model (list/history) reflects the
// custom title, and invalid titles (empty / whitespace-only / >80 chars)
// are rejected with 400.

const CONFIG_TOML = `
model = "p1/model-a"

[provider.p1]
base_url = "http://p1.invalid"
api_key = "k1"

[provider.p1.models.model-a]
context_window = 100000
max_output = 4096
`;

// A network-free provider; rename never calls it, but bootstrap needs one.
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
  const root = await Deno.makeTempDir({ prefix: "niuma_rename_" });
  const workspace = join(root, "ws");
  await Deno.mkdir(workspace, { recursive: true });
  return { root, workspace };
};

const buildApp = async (f: Fixture) => {
  const boot = await bootstrap({
    paths: dataPaths(f.root, f.workspace),
    config: parseConfig(CONFIG_TOML),
    infra: { provider: makeCaptureProvider([]) },
  });
  return await createServerApp({ bootstrap: boot });
};

type App = { fetch: (req: Request) => Response | Promise<Response> };

const createSession = async (app: App): Promise<string> => {
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

Deno.test({
  name: "rename persists session.title.changed and the list shows it (trimmed)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const f = await makeFixture();
    const { app } = await buildApp(f);
    const sessionId = await createSession(app);

    const res = await post(app, `/sessions/${sessionId}/title`, {
      title: "  my session  ",
    });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: true, title: "my session" });

    // The Journal's tail is the recorded session.title.changed event.
    const history = await (await app.fetch(
      new Request(`http://niuma.internal/sessions/${sessionId}/history`),
    )).json();
    const events = history.events as Array<{ type: string; data?: unknown }>;
    const last = events[events.length - 1];
    assertEquals(last.type, "session.title.changed");
    assertEquals(last.data, { title: "my session" });

    // The folded read model (session list) reflects the custom title.
    const list = await (await app.fetch(
      new Request("http://niuma.internal/sessions"),
    )).json();
    const info = (list as Array<{ sessionId: string; title?: string }>).find(
      (s) => s.sessionId === sessionId,
    );
    assert(info !== undefined);
    assertEquals(info.title, "my session");
  },
});

Deno.test({
  name: "rename rejects empty, whitespace-only, and overlong titles with 400",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const f = await makeFixture();
    const { app } = await buildApp(f);
    const sessionId = await createSession(app);

    for (const title of ["", "   ", "x".repeat(81)]) {
      const res = await post(app, `/sessions/${sessionId}/title`, { title });
      assertEquals(res.status, 400, `title ${JSON.stringify(title)}`);
      assertEquals((await res.json()).error.code, "bad_request");
    }

    // An exactly-80-char title is accepted.
    const ok = await post(app, `/sessions/${sessionId}/title`, {
      title: "x".repeat(80),
    });
    assertEquals(ok.status, 200);
  },
});

Deno.test({
  name: "rename on a missing session returns session_not_found",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const f = await makeFixture();
    const { app } = await buildApp(f);

    const res = await post(app, "/sessions/deadbeef/title", {
      title: "nope",
    });
    assertEquals(res.status, 404);
    assertEquals((await res.json()).error.code, "session_not_found");
  },
});
