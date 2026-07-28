// UsageArchive keeps model analytics while proving prompt, response, tool
// input, and provider error text never cross the archival Interface.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { makeSessionStore } from "../src/session_store.ts";
import {
  CorruptUsageArchiveError,
  makeUsageArchive,
  UsageArchiveConflictError,
} from "../src/usage_archive.ts";
import {
  ensureWorkspaceLayout,
  makeWorkspaceLayout,
} from "../src/workspace_layout.ts";

const fixture = async () => {
  const root = await Deno.makeTempDir({ prefix: "niuma_usage_archive_" });
  const workspace = join(root, "workspace");
  await Deno.mkdir(workspace, { recursive: true });
  const layout = makeWorkspaceLayout(root, workspace);
  await ensureWorkspaceLayout(layout);
  const store = makeSessionStore({ layout });
  const archive = makeUsageArchive({ layout, now: () => 9_999 });
  return { root, layout, store, archive };
};

const seed = async (f: Awaited<ReturnType<typeof fixture>>) => {
  await f.store.append({
    sessionId: "s1",
    type: "session.created",
    ts: 10,
    data: {
      workspace: f.layout.workspace,
      model: "openai/gpt-5",
      mcpServers: [],
    },
  });
  await f.store.append({
    sessionId: "s1",
    type: "user.message",
    ts: 11,
    data: { parts: [{ type: "text", text: "TOP SECRET PROMPT" }] },
  });
  await f.store.append({
    sessionId: "s1",
    type: "tool.call.requested",
    ts: 12,
    data: {
      callId: "tool-1",
      name: "bash",
      input: { command: "echo TOP_SECRET_TOOL" },
    },
  });
  await f.store.append({
    sessionId: "s1",
    type: "model.call.completed",
    ts: 13,
    data: {
      callId: "call-1",
      turnId: "turn-1",
      purpose: "agent",
      actor: "main",
      providerId: "openai",
      modelId: "gpt-5",
      billingMode: "subscription",
      durationMs: 321,
      attempts: 2,
      finishReason: "stop",
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 5,
        cachedInputTokens: 80,
        cacheWriteTokens: 4,
      },
    },
  });
  await f.store.append({
    sessionId: "s1",
    type: "model.call.failed",
    ts: 14,
    data: {
      callId: "call-2",
      turnId: "turn-1",
      purpose: "compaction",
      actor: "subagent",
      providerId: "openai",
      modelId: "gpt-5",
      billingMode: "api",
      durationMs: 50,
      attempts: 5,
      error: "TOP SECRET PROVIDER ERROR",
    },
  });
};

Deno.test("UsageArchive extracts only strict content-free Usage Records", async () => {
  const f = await fixture();
  try {
    await seed(f);
    const events = await f.store.read("s1");
    assert(events);
    const result = await f.archive.archive("s1", events);
    assertEquals(result.created, true);
    assertEquals(result.recordCount, 2);

    const raw = await Deno.readTextFile(result.path);
    assertEquals(raw.includes("TOP SECRET PROMPT"), false);
    assertEquals(raw.includes("TOP_SECRET_TOOL"), false);
    assertEquals(raw.includes("TOP SECRET PROVIDER ERROR"), false);

    const archived = await f.archive.read("s1");
    assert(archived);
    assertEquals(archived.header.workspace, f.layout.workspace);
    assertEquals(archived.records[0].usage, {
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 5,
      cachedInputTokens: 80,
      cacheWriteTokens: 4,
    });
    assertEquals(archived.records[1].outcome, "failed");
    assertEquals(archived.records[1].usage, {
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cachedInputTokens: null,
      cacheWriteTokens: null,
    });
    assertEquals("error" in archived.records[1], false);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("UsageArchive is idempotent and ignores orphan temp files", async () => {
  const f = await fixture();
  try {
    await seed(f);
    await Deno.writeTextFile(join(f.layout.usage, ".s1-crash.tmp"), "partial");
    const events = (await f.store.read("s1"))!;
    assertEquals((await f.archive.archive("s1", events)).created, true);
    assertEquals((await f.archive.archive("s1", events)).created, false);
    assertEquals((await f.archive.read("s1"))?.records.length, 2);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("UsageArchive extends a valid prefix after a resumed Session adds calls", async () => {
  const f = await fixture();
  try {
    await seed(f);
    await f.archive.archive("s1", (await f.store.read("s1"))!);
    await f.store.append({
      sessionId: "s1",
      type: "model.call.completed",
      data: {
        callId: "call-3",
        turnId: "turn-2",
        purpose: "agent",
        actor: "main",
        providerId: "openai",
        modelId: "gpt-5",
        billingMode: "api",
        durationMs: 1,
        attempts: 1,
        finishReason: "stop",
        usage: { inputTokens: null, outputTokens: null },
      },
    });
    const changed = (await f.store.read("s1"))!;
    const result = await f.archive.archive("s1", changed);
    assertEquals(result.created, false);
    assertEquals(result.recordCount, 3);
    assertEquals((await f.archive.read("s1"))?.records.length, 3);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("UsageArchive rejects rewritten archived history", async () => {
  const f = await fixture();
  try {
    await seed(f);
    const events = (await f.store.read("s1"))!;
    await f.archive.archive("s1", events);
    const changed = events.map((event) =>
      event.type === "model.call.completed"
        ? {
          ...event,
          data: {
            ...event.data,
            durationMs: event.data.durationMs + 1,
          },
        }
        : event
    );
    await assertRejects(
      () => f.archive.archive("s1", changed),
      UsageArchiveConflictError,
    );
    assertEquals((await f.archive.read("s1"))?.records.length, 2);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("UsageArchive deletes and rebuilds a corrupt derived file", async () => {
  const f = await fixture();
  try {
    await seed(f);
    await Deno.writeTextFile(f.archive.pathFor("s1"), '{"partial":');
    const result = await f.archive.archive(
      "s1",
      (await f.store.read("s1"))!,
    );
    assertEquals(result.created, true);
    assertEquals((await f.archive.read("s1"))?.records.length, 2);

    await Deno.writeTextFile(f.archive.pathFor("s1"), '{"partial":');
    await assertRejects(
      () => f.archive.read("s1"),
      CorruptUsageArchiveError,
    );
    assertEquals(await f.archive.read("s1"), undefined);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});
