import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { Effect, Stream } from "effect";
import type {
  ChatRequest,
  ModelRef,
  ProviderAdapter,
  StreamEvent,
  Usage,
} from "@niuma/provider";
import { parseConfig } from "@niuma/config";
import { createServerApp } from "../mod.ts";
import { bootstrap } from "../src/bootstrap.ts";
import { dataPaths } from "../src/paths.ts";

// Agent skills end-to-end: bootstrap discovers SKILL.md files once, the
// system prompt carries the <available_skills> listing (main + subagent
// turns alike), and the `skill` tool expands $ARGUMENTS-style args through
// the shared registry. All discovery dirs are injected temp dirs, so the
// real ~/.niuma / ~/.agents are never scanned.

const CONFIG_TOML = `
model = "p1/model-a"

[provider.p1]
base_url = "http://p1.invalid"
api_key = "k1"

[provider.p1.models.model-a]
context_window = 100000
max_output = 4096
`;

const USAGE: Usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly global: string;
  readonly agents: string;
}

const makeFixture = async (): Promise<Fixture> => {
  const root = await Deno.makeTempDir({ prefix: "niuma_skills_" });
  const workspace = join(root, "ws");
  const global = join(root, "global");
  const agents = join(root, "agents");
  await Deno.mkdir(workspace, { recursive: true });
  await Deno.mkdir(global, { recursive: true });
  await Deno.mkdir(agents, { recursive: true });
  return { root, workspace, global, agents };
};

const writeProjectSkill = async (
  workspace: string,
  dir: string,
  name: string,
  body: string,
): Promise<void> => {
  const d = join(workspace, ".niuma", "skills", dir);
  await Deno.mkdir(d, { recursive: true });
  await Deno.writeTextFile(
    join(d, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}`,
  );
};

const buildApp = async (f: Fixture, provider: ProviderAdapter) => {
  const boot = await bootstrap({
    paths: dataPaths(f.root, f.workspace),
    config: parseConfig(CONFIG_TOML),
    infra: {
      provider,
      globalConfigDir: f.global,
      agentsSkillsDir: f.agents,
    },
  });
  return await createServerApp({ bootstrap: boot });
};

type App = { fetch: (req: Request) => Response | Promise<Response> };

type Recorded = {
  readonly type: string;
  readonly data?: Record<string, unknown>;
};

const createSession = async (app: App): Promise<string> => {
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

const postPrompt = async (app: App, sessionId: string, text: string) => {
  const res = await app.fetch(
    new Request(`http://niuma.internal/sessions/${sessionId}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }),
  );
  assertEquals(res.status, 202);
};

const history = async (app: App, sessionId: string): Promise<Recorded[]> => {
  const res = await app.fetch(
    new Request(`http://niuma.internal/sessions/${sessionId}/history`),
  );
  assertEquals(res.status, 200);
  return ((await res.json()).events ?? []) as Recorded[];
};

const waitFor = async (
  label: string,
  cond: () => Promise<boolean>,
  timeoutMs = 10000,
): Promise<void> => {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

// ---- Scripted, network-free providers (mirrors @niuma/provider mock.ts). ----

const countToolResults = (req: ChatRequest): number =>
  req.messages.filter((m) => m.role === "tool").length;

const firstUserText = (req: ChatRequest): string =>
  req.messages.find((m) => m.role === "user")?.content ?? "";

const toolCallTurn = (
  id: string,
  name: string,
  args: Record<string, unknown>,
): ReadonlyArray<StreamEvent> => [
  {
    _tag: "ToolCall",
    id,
    name,
    arguments: JSON.stringify(args),
  } as StreamEvent,
  { _tag: "Finish", reason: "tool_calls", usage: USAGE } as StreamEvent,
];

const finalTurn = (text: string): ReadonlyArray<StreamEvent> => [
  { _tag: "TextDelta", text } as StreamEvent,
  { _tag: "Finish", reason: "stop", usage: USAGE } as StreamEvent,
];

const listModels = (): Effect.Effect<ReadonlyArray<ModelRef>> =>
  Effect.succeed([{ id: "model-a", name: "model-a" }]);

// Captures every request and answers with a plain final text — for the
// system-prompt listing assertions.
const makeCaptureProvider = (sink: ChatRequest[]): ProviderAdapter => ({
  listModels,
  stream: (req): Stream.Stream<StreamEvent> => {
    sink.push(req);
    return Stream.fromIterable(finalTurn("ok"));
  },
});

// ---------------------------------------------------------------------------
// Case 1: the system prompt carries the skills listing
// ---------------------------------------------------------------------------

Deno.test({
  name: "skills: system prompt lists discovered skills and the skill tool",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const f = await makeFixture();
    await writeProjectSkill(f.workspace, "shout", "shout", "SHOUT: $ARGUMENTS");
    const sink: ChatRequest[] = [];
    const { app } = await buildApp(f, makeCaptureProvider(sink));
    const sessionId = await createSession(app);
    await postPrompt(app, sessionId, "hello");

    await waitFor(
      "the provider request",
      () => Promise.resolve(sink.length > 0),
    );
    const system = sink[0].system ?? "";
    // Line-anchored block form: the base instructions mention
    // <available_skills> inline, so a bare substring check is not proof.
    assert(system.includes("\n<available_skills>\n"), system.slice(0, 400));
    assert(system.includes("- shout: shout skill"), system.slice(0, 400));
    assert(
      sink[0].tools.some((t) => t.name === "skill"),
      "skill tool def missing",
    );
  },
});

Deno.test({
  name: "skills: no skills dirs → no <available_skills> block",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const f = await makeFixture();
    const sink: ChatRequest[] = [];
    const { app } = await buildApp(f, makeCaptureProvider(sink));
    const sessionId = await createSession(app);
    await postPrompt(app, sessionId, "hello");

    await waitFor(
      "the provider request",
      () => Promise.resolve(sink.length > 0),
    );
    const system = sink[0].system ?? "";
    assert(!system.includes("\n<available_skills>\n"));
    // The tool is still registered — it just reports an empty listing.
    assert(sink[0].tools.some((t) => t.name === "skill"));
  },
});

// ---------------------------------------------------------------------------
// Case 2: the skill tool runs end-to-end with $ARGUMENTS expansion
// ---------------------------------------------------------------------------

Deno.test({
  name: "skills: skill tool call records the expanded body in tool.result",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const f = await makeFixture();
    await writeProjectSkill(f.workspace, "shout", "shout", "SHOUT: $ARGUMENTS");
    const provider: ProviderAdapter = {
      listModels,
      stream: (req): Stream.Stream<StreamEvent> =>
        Stream.fromIterable(
          countToolResults(req) === 0
            ? toolCallTurn("call-1", "skill", {
              name: "shout",
              args: "hello world",
            })
            : finalTurn("done"),
        ),
    };
    const { app } = await buildApp(f, provider);
    const sessionId = await createSession(app);
    await postPrompt(app, sessionId, "use the shout skill");

    let result: Recorded | undefined;
    await waitFor("skill tool.result", async () => {
      result = (await history(app, sessionId)).find((e) =>
        e.type === "tool.result"
      );
      return result !== undefined;
    });
    const rawContent = result?.data?.content;
    const content = typeof rawContent === "string"
      ? rawContent
      : JSON.stringify(rawContent ?? "");
    assert(content.includes('<skill name="shout"'), content);
    assert(content.includes("SHOUT: hello world"), content);
    assertEquals(result?.data?.isError, false);
  },
});

// ---------------------------------------------------------------------------
// Case 3: a subagent gets the same listing and tool via the shared registry
// ---------------------------------------------------------------------------

Deno.test({
  name: "skills: subagent turn sees the listing and its skill call succeeds",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const f = await makeFixture();
    await writeProjectSkill(f.workspace, "shout", "shout", "SHOUT: $ARGUMENTS");
    const sink: ChatRequest[] = [];
    const provider: ProviderAdapter = {
      listModels,
      stream: (req): Stream.Stream<StreamEvent> => {
        sink.push(req);
        if (firstUserText(req).includes("skill-child")) {
          return Stream.fromIterable(
            countToolResults(req) === 0
              ? toolCallTurn("child-call", "skill", {
                name: "shout",
                args: "from child",
              })
              : finalTurn("child done"),
          );
        }
        return Stream.fromIterable(
          countToolResults(req) === 0
            ? toolCallTurn("parent-call", "spawn_subagent", {
              prompt: "skill-child flow",
              name: "kid",
            })
            : finalTurn("parent done"),
        );
      },
    };
    const { app } = await buildApp(f, provider);
    const sessionId = await createSession(app);
    await postPrompt(app, sessionId, "spawn a child");

    // spawn_subagent is not auto-allowed: resolve the parked approval.
    let approvalId = "";
    await waitFor("the spawn_subagent approval", async () => {
      const events = await history(app, sessionId);
      const requested = events.find((e) => e.type === "approval.requested");
      approvalId = (requested?.data?.approvalId as string) ?? "";
      return approvalId !== "";
    });
    const approve = await app.fetch(
      new Request(
        `http://niuma.internal/sessions/${sessionId}/approvals/${approvalId}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: "once" }),
        },
      ),
    );
    assertEquals(approve.status, 200);

    // The parent journal records the lineage; the child id comes from
    // subagent.spawned.
    let childId = "";
    await waitFor("subagent completion", async () => {
      const events = await history(app, sessionId);
      childId = (events.find((e) => e.type === "subagent.spawned")?.data
        ?.childSessionId as string) ?? "";
      return events.some((e) => e.type === "subagent.completed");
    });
    assert(childId !== "");

    // The child's own journal carries the expanded skill body; the skill
    // call needed no approval (READ_ONLY_TOOLS).
    let childResult: Recorded | undefined;
    await waitFor("child skill tool.result", async () => {
      childResult = (await history(app, childId)).find((e) =>
        e.type === "tool.result"
      );
      return childResult !== undefined;
    });
    const rawChild = childResult?.data?.content;
    const childContent = typeof rawChild === "string"
      ? rawChild
      : JSON.stringify(rawChild ?? "");
    assert(childContent.includes("SHOUT: from child"), childContent);
    const childEvents = await history(app, childId);
    assert(!childEvents.some((e) => e.type === "approval.requested"));

    // The child's system prompt carried the same listing.
    const childRequest = sink.find((r) =>
      firstUserText(r).includes("skill-child")
    );
    assert(childRequest !== undefined);
    assert(
      (childRequest.system ?? "").includes("- shout: shout skill"),
      (childRequest.system ?? "").slice(0, 400),
    );
  },
});

// ---------------------------------------------------------------------------
// Case 4: a skill also answers to /name args (spec §3.7)
// ---------------------------------------------------------------------------

const lastUserText = (req: ChatRequest): string =>
  [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";

const writeProjectCommand = async (
  workspace: string,
  name: string,
  text: string,
): Promise<void> => {
  const d = join(workspace, ".niuma", "commands");
  await Deno.mkdir(d, { recursive: true });
  await Deno.writeTextFile(join(d, `${name}.md`), text);
};

Deno.test({
  name: "skills: /skillname args expands the skill body and keeps sourceText",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const f = await makeFixture();
    await writeProjectSkill(f.workspace, "shout", "shout", "SHOUT: $ARGUMENTS");
    const sink: ChatRequest[] = [];
    const { app } = await buildApp(f, makeCaptureProvider(sink));
    const sessionId = await createSession(app);
    await postPrompt(app, sessionId, "/shout hello world");

    await waitFor(
      "the provider request",
      () => Promise.resolve(sink.length > 0),
    );
    assertEquals(lastUserText(sink[0]), "SHOUT: hello world");

    let userMessage: Recorded | undefined;
    await waitFor("the user.message event", async () => {
      userMessage = (await history(app, sessionId)).find((e) =>
        e.type === "user.message"
      );
      return userMessage !== undefined;
    });
    const parts = userMessage?.data?.parts as Array<{ text: string }>;
    assertEquals(parts[0].text, "SHOUT: hello world");
    assertEquals(userMessage?.data?.sourceText, "/shout hello world");
  },
});

Deno.test({
  name: "skills: create response lists skills as /name commands",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const f = await makeFixture();
    await writeProjectSkill(f.workspace, "shout", "shout", "SHOUT: $ARGUMENTS");
    const { app } = await buildApp(f, makeCaptureProvider([]));
    const res = await app.fetch(
      new Request("http://niuma.internal/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "model-a" }),
      }),
    );
    assertEquals(res.status, 201);
    const body = await res.json();
    const commands = body.commands as Array<{
      name: string;
      description?: string;
    }>;
    const entry = commands.find((c) => c.name === "shout");
    assert(entry !== undefined, "skill missing from commands listing");
    assertEquals(entry.description, "shout skill");
  },
});

Deno.test({
  name: "skills: a same-named commands/*.md wins over the skill on both paths",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const f = await makeFixture();
    await writeProjectSkill(f.workspace, "shout", "shout", "SHOUT: $ARGUMENTS");
    await writeProjectCommand(
      f.workspace,
      "shout",
      "---\ndescription: command version\n---\nCOMMAND: $ARGUMENTS",
    );
    const sink: ChatRequest[] = [];
    const { app } = await buildApp(f, makeCaptureProvider(sink));

    // Listing path: the command's description wins.
    const res = await app.fetch(
      new Request("http://niuma.internal/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "model-a" }),
      }),
    );
    const body = await res.json();
    const commands = body.commands as Array<{
      name: string;
      description?: string;
    }>;
    assertEquals(
      commands.filter((c) => c.name === "shout").length,
      1,
      "duplicate names in the commands listing",
    );
    assertEquals(
      commands.find((c) => c.name === "shout")?.description,
      "command version",
    );

    // Expansion path: the command's template wins.
    const sessionId = body.sessionId as string;
    await postPrompt(app, sessionId, "/shout a b");
    await waitFor(
      "the provider request",
      () => Promise.resolve(sink.length > 0),
    );
    assertEquals(lastUserText(sink[0]), "COMMAND: a b");
  },
});

Deno.test({
  name: "skills: no matching skill or command — /whatever passes through",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const f = await makeFixture();
    await writeProjectSkill(f.workspace, "shout", "shout", "SHOUT: $ARGUMENTS");
    const sink: ChatRequest[] = [];
    const { app } = await buildApp(f, makeCaptureProvider(sink));
    const sessionId = await createSession(app);
    await postPrompt(app, sessionId, "/whatever foo");

    await waitFor(
      "the provider request",
      () => Promise.resolve(sink.length > 0),
    );
    assertEquals(lastUserText(sink[0]), "/whatever foo");

    let userMessage: Recorded | undefined;
    await waitFor("the user.message event", async () => {
      userMessage = (await history(app, sessionId)).find((e) =>
        e.type === "user.message"
      );
      return userMessage !== undefined;
    });
    assertEquals(userMessage?.data?.sourceText, undefined);
  },
});
