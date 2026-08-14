import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { Effect } from "effect";
import type { RecordedEvent } from "@niuma/schema";
import type { SubagentResult } from "@niuma/tools";
import { makeSubagentSpawner, type SubagentRequest } from "../src/bootstrap.ts";
import { makeEventBus } from "../src/event_bus.ts";
import { makeKernel } from "../src/kernel.ts";
import { makeSessionStore, type SessionStore } from "../src/session_store.ts";
import {
  ensureWorkspaceLayout,
  makeWorkspaceLayout,
} from "../src/workspace_layout.ts";

const replay = async (
  store: SessionStore,
  sessionId: string,
): Promise<RecordedEvent[]> => {
  const events: RecordedEvent[] = [];
  for await (const event of store.replay(sessionId)) events.push(event);
  return events;
};

Deno.test("server subagent spawner records lineage and rejects depth two", async () => {
  const root = await Deno.makeTempDir({ prefix: "niuma_subagent_" });
  const workspace = join(root, "workspace");
  await Deno.mkdir(workspace, { recursive: true });

  const layout = makeWorkspaceLayout(root, workspace);
  await ensureWorkspaceLayout(layout);
  const store = makeSessionStore({ layout });
  const kernel = await Effect.runPromise(makeKernel({
    store,
    bus: await Effect.runPromise(makeEventBus()),
  }));
  const parentSessionId = "parent";
  await Effect.runPromise(kernel.append({
    type: "session.created",
    sessionId: parentSessionId,
    data: { workspace, model: "test-model", mcpServers: [] },
  }));

  let runChildMode: "full" | "read-only" | undefined;
  const spawn: (req: SubagentRequest) => Promise<SubagentResult> =
    makeSubagentSpawner({
      kernel,
      workspace,
      model: "test-model",
      mcpServers: [],
      runChild: async (childSessionId, prompt, mode) => {
        runChildMode = mode;
        const nested = await spawn({
          parentSessionId: childSessionId,
          prompt,
          name: "nested",
          callId: "nested-call",
        });
        return { text: `child completed: ${nested.text}`, ok: true };
      },
    });

  const result = await spawn({
    parentSessionId,
    prompt: "inspect the code",
    name: "explorer",
    mode: "read-only",
    callId: "call-1",
  });

  assert(result.sessionId !== parentSessionId);
  assertEquals(runChildMode, "read-only");
  assertEquals(result.ok, true);
  assertStringIncludes(result.text, "Subagent depth limit reached");

  const parentEvents = await replay(store, parentSessionId);
  const lineage = parentEvents.find((event) =>
    event.type === "subagent.spawned"
  );
  assertEquals(lineage?.type, "subagent.spawned");
  if (lineage?.type !== "subagent.spawned") {
    throw new Error("missing subagent.spawned event");
  }
  assertEquals(lineage.data.childSessionId, result.sessionId);
  assertEquals(lineage.data.prompt, "inspect the code");
  assertEquals(lineage.data.name, "explorer");
  assertEquals(lineage.data.callId, "call-1");

  const completed = parentEvents.find((event) =>
    event.type === "subagent.completed"
  );
  assertEquals(completed?.type, "subagent.completed");
  if (completed?.type !== "subagent.completed") {
    throw new Error("missing subagent.completed event");
  }
  assertEquals(completed.data.childSessionId, result.sessionId);
  assertEquals(completed.data.callId, "call-1");
  assertEquals(completed.data.ok, true);
  assertEquals(completed.data.usage, null);
  assertEquals(typeof completed.data.durationMs, "number");

  const childEvents = await replay(store, result.sessionId);
  assertEquals(
    childEvents.map((event) => event.type),
    ["session.created", "user.message"],
  );
  const childCreated = childEvents[0];
  if (childCreated?.type !== "session.created") {
    throw new Error("missing child session.created");
  }
  assertEquals(childCreated.data.parentSessionId, parentSessionId);

  assertEquals(
    await store.listIds(),
    [parentSessionId],
  );
});

Deno.test("store listIds excludes child sessions via first-line probe", async () => {
  const root = await Deno.makeTempDir({ prefix: "niuma_subagent_" });
  const workspace = join(root, "workspace");
  await Deno.mkdir(workspace, { recursive: true });

  const layout = makeWorkspaceLayout(root, workspace);
  await ensureWorkspaceLayout(layout);
  const store = makeSessionStore({ layout });
  const kernel = await Effect.runPromise(makeKernel({
    store,
    bus: await Effect.runPromise(makeEventBus()),
  }));
  await Effect.runPromise(kernel.append({
    type: "session.created",
    sessionId: "parent",
    data: { workspace, model: "m", mcpServers: [] },
  }));
  await Effect.runPromise(kernel.append({
    type: "session.created",
    sessionId: "child-a",
    data: {
      workspace,
      model: "m",
      mcpServers: [],
      parentSessionId: "parent",
    },
  }));
  await Effect.runPromise(kernel.append({
    type: "session.created",
    sessionId: "top",
    data: { workspace, model: "m", mcpServers: [] },
  }));
  assertEquals(await store.listIds(), ["parent", "top"]);
});

Deno.test("server subagent spawner composes failure reason and trace into the result", async () => {
  const root = await Deno.makeTempDir({ prefix: "niuma_subagent_" });
  const workspace = join(root, "workspace");
  await Deno.mkdir(workspace, { recursive: true });

  const layout = makeWorkspaceLayout(root, workspace);
  await ensureWorkspaceLayout(layout);
  const store = makeSessionStore({ layout });
  const kernel = await Effect.runPromise(makeKernel({
    store,
    bus: await Effect.runPromise(makeEventBus()),
  }));
  const parentSessionId = "parent";
  await Effect.runPromise(kernel.append({
    type: "session.created",
    sessionId: parentSessionId,
    data: { workspace, model: "test-model", mcpServers: [] },
  }));

  const spawn = makeSubagentSpawner({
    kernel,
    workspace,
    model: "test-model",
    mcpServers: [],
    runChild: () =>
      // Simulate the child loop terminating abnormally.
      Promise.resolve({ text: "", ok: false, reason: "provider exploded" }),
  });
  const result = await spawn({
    parentSessionId,
    prompt: "p",
    name: "n",
    callId: "c",
  });
  assertEquals(result.ok, false);
  assertStringIncludes(result.text, "provider exploded");
  assertStringIncludes(result.text, "execution trace:");
  assertStringIncludes(result.text, "(no events recorded)");
});
