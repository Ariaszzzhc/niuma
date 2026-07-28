import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { parseEventLine } from "@niuma/schema";
import { CorruptSessionError, makeSessionStore } from "../src/session_store.ts";
import {
  ensureWorkspaceLayout,
  makeWorkspaceLayout,
} from "../src/workspace_layout.ts";

const fixture = async () => {
  const root = await Deno.makeTempDir();
  const layout = makeWorkspaceLayout(root, join(root, "work"));
  await ensureWorkspaceLayout(layout);
  return {
    root,
    layout,
    store: makeSessionStore({ layout, now: () => 100 }),
  };
};

Deno.test("SessionStore assigns seq and replays one Session Journal", async () => {
  const f = await fixture();
  try {
    const created = await f.store.append({
      sessionId: "s1",
      type: "session.created",
      data: {
        workspace: f.layout.workspace,
        model: "openai/gpt-5",
        mcpServers: [],
      },
    });
    const message = await f.store.append({
      sessionId: "s1",
      type: "user.message",
      data: { parts: [{ type: "text", text: "hello" }] },
    });
    assertEquals([created.seq, message.seq], [1, 2]);
    assertEquals((await f.store.read("s1"))?.map((event) => event.type), [
      "session.created",
      "user.message",
    ]);
    assertEquals((await f.store.state("s1"))?.info.title, "hello");
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("SessionStore discards only a truncated final append", async () => {
  const f = await fixture();
  try {
    await f.store.append({
      sessionId: "s1",
      type: "session.created",
      data: {
        workspace: f.layout.workspace,
        model: "m",
        mcpServers: [],
      },
    });
    await Deno.writeTextFile(f.store.pathFor("s1"), '{"seq":2', {
      append: true,
    });

    const events = await f.store.read("s1");
    assertEquals(events?.length, 1);
    const text = await Deno.readTextFile(f.store.pathFor("s1"));
    assertEquals(text.endsWith("\n"), true);
    assertEquals(parseEventLine(text.trim()).seq, 1);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("SessionStore deletes structurally corrupted Journals", async () => {
  const f = await fixture();
  try {
    await f.store.append({
      sessionId: "s1",
      type: "session.created",
      data: {
        workspace: f.layout.workspace,
        model: "m",
        mcpServers: [],
      },
    });
    const path = f.store.pathFor("s1");
    const text = await Deno.readTextFile(path);
    await Deno.writeTextFile(path, `${text}not-json\n`);
    await assertRejects(() => f.store.read("s1"), CorruptSessionError);
    await assertRejects(() => Deno.stat(path), Deno.errors.NotFound);
    await assertRejects(
      () =>
        f.store.append({
          sessionId: "s1",
          type: "user.message",
          data: { parts: [{ type: "text", text: "do not revive" }] },
        }),
      Error,
      "must be session.created",
    );
    await assertRejects(() => Deno.stat(path), Deno.errors.NotFound);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("SessionStore resumes sequence monotonically after reopening", async () => {
  const f = await fixture();
  try {
    await f.store.append({
      sessionId: "s1",
      type: "session.created",
      data: {
        workspace: f.layout.workspace,
        model: "m",
        mcpServers: [],
      },
    });
    await f.store.append({
      sessionId: "s1",
      type: "user.message",
      data: { parts: [{ type: "text", text: "hello" }] },
    });

    const reopened = makeSessionStore({ layout: f.layout, now: () => 200 });
    const next = await reopened.append({
      sessionId: "s1",
      type: "turn.started",
      data: { turnId: "t1" },
    });
    assertEquals(next.seq, 3);
    assertEquals((await reopened.read("s1"))?.map((event) => event.seq), [
      1,
      2,
      3,
    ]);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("SessionStore lists only the current Workspace directory", async () => {
  const f = await fixture();
  try {
    await f.store.append({
      sessionId: "s1",
      type: "session.created",
      data: {
        workspace: f.layout.workspace,
        model: "m",
        mcpServers: [],
      },
    });
    const otherLayout = makeWorkspaceLayout(f.root, join(f.root, "other"));
    await ensureWorkspaceLayout(otherLayout);
    const other = makeSessionStore({ layout: otherLayout });
    await other.append({
      sessionId: "s2",
      type: "session.created",
      data: {
        workspace: otherLayout.workspace,
        model: "m",
        mcpServers: [],
      },
    });

    assertEquals(await f.store.listIds(), ["s1"]);
    assertEquals((await f.store.listRecent()).map((s) => s.info.sessionId), [
      "s1",
    ]);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("SessionStore serializes replay with concurrent appends", async () => {
  const f = await fixture();
  try {
    await f.store.append({
      sessionId: "s1",
      type: "session.created",
      data: {
        workspace: f.layout.workspace,
        model: "p/m",
        mcpServers: [],
      },
    });

    const appends = Array.from({ length: 50 }, (_, index) =>
      f.store.append({
        sessionId: "s1",
        type: "user.message",
        data: {
          parts: [{ type: "text", text: `message-${index}` }],
        },
      }));
    const replays = Array.from({ length: 50 }, async () => {
      const events = [];
      for await (const event of f.store.replay("s1")) events.push(event);
      return events;
    });
    await Promise.all([...appends, ...replays]);

    const final = await f.store.read("s1");
    assertEquals(final?.length, 51);
    assertEquals(
      final?.map((event) => event.seq),
      Array.from({ length: 51 }, (_, index) => index + 1),
    );
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("SessionStore touch distinguishes a live Journal from a removed one", async () => {
  const f = await fixture();
  try {
    assertEquals(await f.store.touch("missing"), false);
    await f.store.append({
      sessionId: "s1",
      type: "session.created",
      data: {
        workspace: f.layout.workspace,
        model: "p/m",
        mcpServers: [],
      },
    });
    assertEquals(await f.store.touch("s1"), true);
    await f.store.remove("s1");
    assertEquals(await f.store.touch("s1"), false);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});
