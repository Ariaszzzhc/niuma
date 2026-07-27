import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { Effect } from "effect";
import type { RecordedEvent } from "@niuma/schema";
import type { SubagentResult } from "@niuma/tools";
import { makeSubagentSpawner, type SubagentRequest } from "../src/bootstrap.ts";
import { makeEventBus } from "../src/event_bus.ts";
import { makeEventLog } from "../src/event_log.ts";
import { makeKernel } from "../src/kernel.ts";
import { ensureSchema } from "../src/projection.ts";

const replay = async (
  eventLog: ReturnType<typeof makeEventLog>,
  sessionId: string,
): Promise<RecordedEvent[]> => {
  const events: RecordedEvent[] = [];
  for await (const event of eventLog.replay(sessionId)) events.push(event);
  return events;
};

Deno.test("server subagent spawner records lineage and rejects depth two", async () => {
  const root = await Deno.makeTempDir({ prefix: "niuma_subagent_" });
  const sessions = join(root, "sessions");
  const workspace = join(root, "workspace");
  await Deno.mkdir(sessions, { recursive: true });
  await Deno.mkdir(workspace, { recursive: true });

  const eventLog = makeEventLog({ sessionsDir: sessions });
  const kernel = await Effect.runPromise(makeKernel({
    event_log: eventLog,
    projection: await ensureSchema(join(root, "niuma.db")),
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
        });
        return `child completed: ${nested.text}`;
      },
    });

  const result = await spawn({
    parentSessionId,
    prompt: "inspect the code",
    mode: "read-only",
  });

  assert(result.sessionId !== parentSessionId);
  assertEquals(runChildMode, "read-only");
  assertStringIncludes(result.text, "Subagent depth limit reached");

  const parentEvents = await replay(eventLog, parentSessionId);
  const lineage = parentEvents.find((event) =>
    event.type === "subagent.spawned"
  );
  assertEquals(lineage?.type, "subagent.spawned");
  if (lineage?.type !== "subagent.spawned") {
    throw new Error("missing subagent.spawned event");
  }
  assertEquals(lineage.data.childSessionId, result.sessionId);
  assertEquals(lineage.data.prompt, "inspect the code");

  const childEvents = await replay(eventLog, result.sessionId);
  assertEquals(
    childEvents.map((event) => event.type),
    ["session.created", "user.message"],
  );
  const childInput = childEvents[1];
  assertEquals(childInput?.type, "user.message");
  if (childInput?.type === "user.message") {
    assertEquals(childInput.data.parts, [{
      type: "text",
      text: "inspect the code",
    }]);
  }
  assertEquals(
    await eventLog.listSessions(),
    [
      parentSessionId,
      result.sessionId,
    ].sort(),
  );
});
