// Resume is explicit, current-Workspace-only, and rebuilds all runtime model
// decisions from one Session Journal after a Server restart.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { Effect, Stream } from "effect";
import { parseConfig } from "@niuma/config";
import type {
  ChatRequest,
  ProviderAdapter,
  StreamEvent,
} from "@niuma/provider";
import { createServerApp } from "../src/app.ts";
import { bootstrap } from "../src/bootstrap.ts";
import { dataPaths } from "../src/paths.ts";
import { makeSessionStore, type SessionStore } from "../src/session_store.ts";
import { ensureWorkspaceLayout } from "../src/workspace_layout.ts";

const CONFIG = parseConfig(`
model = "p/model-a"

[provider.p]
base_url = "http://p.invalid"
api_key = "test"

[provider.p.models.model-a]
context_window = 100000
max_output = 1000

[provider.p.models.model-b]
context_window = 50000
max_output = 2000
`);

const captureProvider = (requests: ChatRequest[]): ProviderAdapter => ({
  listModels: () => Effect.succeed([]),
  stream: (request) => {
    requests.push(request);
    return Stream.fromIterable([
      { _tag: "TextDelta", text: "resumed" } as StreamEvent,
      {
        _tag: "Finish",
        reason: "stop",
        usage: { promptTokens: 3, completionTokens: 1 },
      } as StreamEvent,
    ]);
  },
});

const request = (
  path: string,
  method = "GET",
  body?: unknown,
): Request =>
  new Request(`http://niuma.internal${path}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  });

const waitForTurn = async (
  app: Awaited<ReturnType<typeof createServerApp>>,
  sessionId: string,
) => {
  for (let i = 0; i < 50; i++) {
    const response = await app.app.fetch(
      request(`/sessions/${sessionId}/history`),
    );
    const history = await response.json();
    if (
      (history.events as Array<{ type: string }>).some((event) =>
        event.type === "turn.completed"
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("resumed Turn did not complete");
};

Deno.test({
  name: "Resume after restart restores model/effort and closes stale lifecycle",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const root = await Deno.makeTempDir({ prefix: "niuma_resume_" });
    const workspace = join(root, "workspace");
    await Deno.mkdir(workspace, { recursive: true });
    const paths = dataPaths(root, workspace);
    const firstRequests: ChatRequest[] = [];
    const firstBoot = await bootstrap({
      paths,
      config: CONFIG,
      mcpConfig: {},
      infra: { provider: captureProvider(firstRequests) },
    });
    const first = await createServerApp({ bootstrap: firstBoot });
    let sessionId = "";
    try {
      const created = await first.app.fetch(
        request("/sessions", "POST", {}),
      );
      assertEquals(created.status, 201);
      sessionId = (await created.json()).sessionId as string;
      assertEquals(
        (await first.app.fetch(
          request(`/sessions/${sessionId}/model`, "POST", {
            model: "model-b",
          }),
        )).status,
        200,
      );
      assertEquals(
        (await first.app.fetch(
          request(`/sessions/${sessionId}/effort`, "POST", {
            effort: "high",
          }),
        )).status,
        200,
      );
    } finally {
      await first.close();
    }

    // Simulate a process ending after it recorded a Turn and approval but
    // before either reached a terminal event.
    await firstBoot.store.append({
      sessionId,
      type: "turn.started",
      data: { turnId: "stale-turn" },
    });
    await firstBoot.store.append({
      sessionId,
      type: "approval.requested",
      data: {
        approvalId: "stale-approval",
        callId: "tool-1",
        name: "bash",
        input: { command: "pwd" },
      },
    });

    const resumedRequests: ChatRequest[] = [];
    const second = await createServerApp({
      bootstrap: await bootstrap({
        paths,
        config: CONFIG,
        mcpConfig: {},
        infra: { provider: captureProvider(resumedRequests) },
      }),
    });
    try {
      const response = await second.app.fetch(
        request(`/sessions/${sessionId}`),
      );
      assertEquals(response.status, 200);
      const payload = await response.json();
      assertEquals(payload.info.model, "p/model-b");
      assertEquals(payload.info.effort, "high");
      assertEquals(payload.info.contextWindow, 50_000);
      assertEquals(payload.info.status, "idle");
      assertEquals(
        payload.history.slice(-2).map((event: { type: string }) => event.type),
        ["approval.resolved", "turn.aborted"],
      );

      const prompt = await second.app.fetch(
        request(`/sessions/${sessionId}/prompt`, "POST", {
          text: "continue",
        }),
      );
      assertEquals(prompt.status, 202);
      await waitForTurn(second, sessionId);
      assertEquals(resumedRequests.length, 1);
      assertEquals(resumedRequests[0].model, "model-b");
      assertEquals(resumedRequests[0].maxTokens, 2_000);
      assertEquals(resumedRequests[0].thinking, { effort: "high" });
    } finally {
      await second.close();
    }

    const otherWorkspace = join(root, "other");
    await Deno.mkdir(otherWorkspace, { recursive: true });
    const other = await createServerApp({
      bootstrap: await bootstrap({
        paths: dataPaths(root, otherWorkspace),
        config: CONFIG,
        mcpConfig: {},
        infra: { provider: captureProvider([]) },
      }),
    });
    try {
      const response = await other.app.fetch(
        request(`/sessions/${sessionId}`),
      );
      assertEquals(response.status, 404);
    } finally {
      await other.close();
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "default Server boot and Session create do not enumerate Journals",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const root = await Deno.makeTempDir({ prefix: "niuma_lazy_boot_" });
    const workspace = join(root, "workspace");
    await Deno.mkdir(workspace, { recursive: true });
    const paths = dataPaths(root, workspace);
    await ensureWorkspaceLayout(paths);
    const real = makeSessionStore({ layout: paths });
    let listIdsCalls = 0;
    let listRecentCalls = 0;
    const store: SessionStore = {
      ...real,
      listIds: () => {
        listIdsCalls += 1;
        return real.listIds();
      },
      listRecent: (limit) => {
        listRecentCalls += 1;
        return real.listRecent(limit);
      },
    };
    const app = await createServerApp({
      bootstrap: await bootstrap({
        paths,
        store,
        config: CONFIG,
        mcpConfig: {},
        infra: { provider: captureProvider([]) },
      }),
    });
    try {
      assertEquals(listIdsCalls, 0);
      assertEquals(listRecentCalls, 0);
      assertEquals(
        (await app.app.fetch(request("/sessions", "POST", {}))).status,
        201,
      );
      assertEquals(listIdsCalls, 0);
      assertEquals(listRecentCalls, 0);

      assertEquals((await app.app.fetch(request("/sessions"))).status, 200);
      assertEquals(listRecentCalls, 1);
      assertEquals(listIdsCalls, 0);
      assertEquals(
        (await app.app.fetch(request("/sessions/ids"))).status,
        200,
      );
      assertEquals(listIdsCalls, 1);
    } finally {
      await app.close();
      await Deno.remove(root, { recursive: true });
    }
  },
});
