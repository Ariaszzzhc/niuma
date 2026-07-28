import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createServerApp } from "../mod.ts";
import { bootstrap } from "../src/bootstrap.ts";
import { dataPaths } from "../src/paths.ts";
import { makeMockProvider } from "@niuma/provider";
import { parseConfig } from "@niuma/config";

// Slash command expansion end-to-end: a `/name args` prompt is expanded
// against the commands/*.md templates before the user.message lands in the
// Session Journal; the typed input survives as sourceText.

interface Fixture {
  readonly root: string;
  readonly globalConfigDir: string;
  readonly workspace: string;
}

const makeFixture = async (): Promise<Fixture> => {
  const root = await Deno.makeTempDir({ prefix: "niuma_cmd_" });
  const globalConfigDir = join(root, "global-config");
  const workspace = join(root, "ws");
  await Deno.mkdir(join(globalConfigDir, "commands"), { recursive: true });
  await Deno.mkdir(join(workspace, ".niuma", "commands"), { recursive: true });
  await Deno.writeTextFile(
    join(globalConfigDir, "commands", "greet.md"),
    "---\ndescription: Say hi\nargument-hint: <name>\n---\nSay hello to $ARGUMENTS.",
  );
  await Deno.writeTextFile(
    join(workspace, ".niuma", "commands", "review.md"),
    "Review $1 carefully.",
  );
  return { root, globalConfigDir, workspace };
};

const buildApp = async (f: Fixture) => {
  const boot = await bootstrap({
    paths: dataPaths(f.root, f.workspace),
    config: parseConfig(""),
    infra: {
      provider: makeMockProvider(),
      globalConfigDir: f.globalConfigDir,
    },
  });
  return await createServerApp({ bootstrap: boot });
};

const createSession = async (
  app: { fetch: (req: Request) => Response | Promise<Response> },
  _workspace: string,
): Promise<{ sessionId: string; commands: Array<{ name: string }> }> => {
  const res = await app.fetch(
    new Request("http://niuma.internal/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "smoke-model" }),
    }),
  );
  assertEquals(res.status, 201);
  return await res.json();
};

const prompt = async (
  app: { fetch: (req: Request) => Response | Promise<Response> },
  sessionId: string,
  text: string,
): Promise<Response> =>
  await app.fetch(
    new Request(`http://niuma.internal/sessions/${sessionId}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }),
  );

interface HistoryEvent {
  type: string;
  data?: {
    parts?: Array<{ type: string; text?: string }>;
    sourceText?: string;
  };
}

// The prompt handler forks the turn on a background fiber — poll the history
// until the user.message event shows up.
const waitForUserMessage = async (
  app: { fetch: (req: Request) => Response | Promise<Response> },
  sessionId: string,
): Promise<HistoryEvent> => {
  for (let i = 0; i < 50; i++) {
    const res = await app.fetch(
      new Request(`http://niuma.internal/sessions/${sessionId}/history`),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    const msg = (body.events as HistoryEvent[]).find(
      (e) => e.type === "user.message",
    );
    if (msg) return msg;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("user.message never appeared in history");
};

Deno.test({
  name: "createSession lists user + project commands",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const f = await makeFixture();
    {
      const { app } = await buildApp(f);
      const created = await createSession(app, f.workspace);
      const names = created.commands.map((c) => c.name).sort();
      assertEquals(names, ["greet", "review"]);
      const greet = created.commands.find((c) => c.name === "greet") as {
        description?: string;
        argumentHint?: string;
      };
      assertEquals(greet.description, "Say hi");
      assertEquals(greet.argumentHint, "<name>");
    }
  },
});

Deno.test({
  name: "a /name args prompt is expanded and keeps sourceText",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const f = await makeFixture();
    {
      const { app } = await buildApp(f);
      const { sessionId } = await createSession(app, f.workspace);
      const res = await prompt(app, sessionId, "/review src/foo.ts");
      assertEquals(res.status, 202);

      const msg = await waitForUserMessage(app, sessionId);
      assertEquals(msg.data?.sourceText, "/review src/foo.ts");
      assertEquals(msg.data?.parts?.length, 1);
      assertEquals(msg.data?.parts?.[0].text, "Review src/foo.ts carefully.");
    }
  },
});

Deno.test({
  name: "$ARGUMENTS placeholder expands with the raw argument string",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const f = await makeFixture();
    {
      const { app } = await buildApp(f);
      const { sessionId } = await createSession(app, f.workspace);
      const res = await prompt(app, sessionId, "/greet Jane Doe");
      assertEquals(res.status, 202);

      const msg = await waitForUserMessage(app, sessionId);
      assertEquals(msg.data?.parts?.[0].text, "Say hello to Jane Doe.");
      assertEquals(msg.data?.sourceText, "/greet Jane Doe");
    }
  },
});

Deno.test({
  name: "an unmatched /whatever prompt passes through untouched",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const f = await makeFixture();
    {
      const { app } = await buildApp(f);
      const { sessionId } = await createSession(app, f.workspace);
      const res = await prompt(app, sessionId, "/nope some args");
      assertEquals(res.status, 202);

      const msg = await waitForUserMessage(app, sessionId);
      assertEquals(msg.data?.parts?.[0].text, "/nope some args");
      assertEquals(msg.data?.sourceText, undefined);
    }
  },
});

Deno.test({
  name: "plain prompts are unaffected",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const f = await makeFixture();
    {
      const { app } = await buildApp(f);
      const { sessionId } = await createSession(app, f.workspace);
      const res = await prompt(app, sessionId, "hello there");
      assertEquals(res.status, 202);

      const msg = await waitForUserMessage(app, sessionId);
      assertEquals(msg.data?.parts?.[0].text, "hello there");
      assertEquals(msg.data?.sourceText, undefined);
    }
  },
});
