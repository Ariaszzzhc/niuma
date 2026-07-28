// Retention contract: age is the only policy, the current Workspace is the
// only scope, and deletion happens only after a verified Usage Archive.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { parseConfig } from "@niuma/config";
import { makeMockProvider } from "@niuma/provider";
import { createServerApp } from "../src/app.ts";
import { bootstrap } from "../src/bootstrap.ts";
import { dataPaths } from "../src/paths.ts";
import { makeRetention } from "../src/retention.ts";
import { makeSessionStore } from "../src/session_store.ts";
import { makeUsageArchive, type UsageArchive } from "../src/usage_archive.ts";
import {
  ensureWorkspaceLayout,
  makeWorkspaceLayout,
} from "../src/workspace_layout.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;

const fixture = async () => {
  const root = await Deno.makeTempDir({ prefix: "niuma_retention_" });
  const workspace = join(root, "workspace");
  await Deno.mkdir(workspace, { recursive: true });
  const layout = makeWorkspaceLayout(root, workspace);
  await ensureWorkspaceLayout(layout);
  const store = makeSessionStore({ layout });
  return { root, layout, store };
};

const seed = async (
  f: Awaited<ReturnType<typeof fixture>>,
  sessionId: string,
) => {
  await f.store.append({
    sessionId,
    type: "session.created",
    data: {
      workspace: f.layout.workspace,
      model: "p/m",
      mcpServers: [],
    },
  });
  await f.store.append({
    sessionId,
    type: "model.call.completed",
    data: {
      callId: `call-${sessionId}`,
      turnId: `turn-${sessionId}`,
      purpose: "agent",
      actor: "main",
      providerId: "p",
      modelId: "m",
      billingMode: "api",
      durationMs: 10,
      attempts: 1,
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 2 },
    },
  });
};

const setAge = async (
  f: Awaited<ReturnType<typeof fixture>>,
  sessionId: string,
  ms: number,
) => {
  const date = new Date(ms);
  await Deno.utime(f.store.pathFor(sessionId), date, date);
};

Deno.test("Retention archives and deletes only expired inactive Sessions", async () => {
  const f = await fixture();
  const now = Date.now();
  try {
    for (const id of ["old", "fresh", "active"]) await seed(f, id);
    await setAge(f, "old", now - 31 * DAY_MS);
    await setAge(f, "fresh", now - 2 * DAY_MS);
    await setAge(f, "active", now - 31 * DAY_MS);

    const archive = makeUsageArchive({ layout: f.layout, now: () => now });
    const result = await makeRetention({
      store: f.store,
      archive,
      retentionDays: 30,
      now: () => now,
      isSessionActive: (id) => Promise.resolve(id === "active"),
    }).sweep();

    assertEquals(result, {
      inspected: 3,
      archived: 1,
      deleted: 1,
      skippedFresh: 1,
      skippedActive: 1,
      failures: [],
    });
    assertEquals(await f.store.read("old"), undefined);
    assert(await archive.read("old"));
    assert(await f.store.read("fresh"));
    assert(await f.store.read("active"));

    // The permanent archive survives subsequent sweeps after the Journal has
    // disappeared.
    await makeRetention({
      store: f.store,
      archive,
      retentionDays: 30,
      now: () => now,
      isSessionActive: (id) => Promise.resolve(id === "active"),
    }).sweep();
    assertEquals((await archive.read("old"))?.records.length, 1);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("Retention never deletes when Usage Archive creation fails", async () => {
  const f = await fixture();
  const now = Date.now();
  try {
    await seed(f, "old");
    await setAge(f, "old", now - 31 * DAY_MS);
    const failing: UsageArchive = {
      pathFor: () => join(f.layout.usage, "old.jsonl"),
      read: () => Promise.resolve(undefined),
      archive: () => Promise.reject(new Error("disk full")),
    };
    const result = await makeRetention({
      store: f.store,
      archive: failing,
      retentionDays: 30,
      now: () => now,
    }).sweep();
    assertEquals(result.deleted, 0);
    assertEquals(result.failures.length, 1);
    assert(await f.store.read("old"));
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("Retention keeps a Journal touched during archival", async () => {
  const f = await fixture();
  const now = Date.now();
  try {
    await seed(f, "old");
    await setAge(f, "old", now - 31 * DAY_MS);
    const real = makeUsageArchive({ layout: f.layout, now: () => now });
    const touching: UsageArchive = {
      pathFor: real.pathFor,
      read: real.read,
      archive: async (sessionId, events) => {
        const result = await real.archive(sessionId, events);
        await f.store.touch(sessionId);
        return result;
      },
    };
    const result = await makeRetention({
      store: f.store,
      archive: touching,
      retentionDays: 30,
      now: () => now,
    }).sweep();
    assertEquals(result.deleted, 0);
    assertEquals(result.skippedFresh, 1);
    assert(await f.store.read("old"));
    assert(await real.read("old"));

    // A resumed Session can add calls after that race. The next expired sweep
    // extends the existing Archive and can then delete the Journal.
    await f.store.append({
      sessionId: "old",
      type: "model.call.completed",
      data: {
        callId: "call-after-resume",
        turnId: "turn-after-resume",
        purpose: "agent",
        actor: "main",
        providerId: "p",
        modelId: "m",
        billingMode: "api",
        durationMs: 5,
        attempts: 1,
        finishReason: "stop",
        usage: { inputTokens: 2, outputTokens: 1 },
      },
    });
    await setAge(f, "old", now - 31 * DAY_MS);
    const completed = await makeRetention({
      store: f.store,
      archive: real,
      retentionDays: 30,
      now: () => now,
    }).sweep();
    assertEquals(completed.deleted, 1);
    assertEquals(await f.store.read("old"), undefined);
    assertEquals((await real.read("old"))?.records.length, 2);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test({
  name: "configured Server runs Retention silently in the background",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const f = await fixture();
    const now = Date.now();
    try {
      await seed(f, "old");
      await setAge(f, "old", now - 31 * DAY_MS);
      const app = await createServerApp({
        bootstrap: await bootstrap({
          paths: dataPaths(f.root, f.layout.workspace),
          store: f.store,
          config: parseConfig("session_retention_days = 30"),
          mcpConfig: {},
          infra: { provider: makeMockProvider() },
        }),
      });
      await app.retentionTask;
      assertEquals(await f.store.read("old"), undefined);
      assert(
        await makeUsageArchive({ layout: f.layout }).read("old"),
      );
      await app.close();
    } finally {
      await Deno.remove(f.root, { recursive: true });
    }
  },
});
