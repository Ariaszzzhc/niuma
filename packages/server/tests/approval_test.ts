import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { Effect, Fiber } from "effect";
import type { RecordedEvent } from "@niuma/schema";
import {
  type ApprovalRegistry,
  makeApprovalRegistry,
} from "../src/event_bus.ts";
import { makeEventLog } from "../src/event_log.ts";
import { makeKernel } from "../src/kernel.ts";
import { ensureSchema } from "../src/projection.ts";

const makeFixture = async () => {
  const root = await Deno.makeTempDir({ prefix: "niuma_approval_" });
  const sessions = join(root, "sessions");
  await Deno.mkdir(sessions, { recursive: true });
  const eventLog = makeEventLog({ sessionsDir: sessions });
  const approvals = await Effect.runPromise(makeApprovalRegistry());
  const kernel = await Effect.runPromise(makeKernel({
    event_log: eventLog,
    projection: await ensureSchema(join(root, "niuma.db")),
    approvals,
  }));
  await Effect.runPromise(kernel.append({
    type: "session.created",
    sessionId: "session",
    data: { workspace: root, model: "test-model", mcpServers: [] },
  }));
  return { approvals, eventLog, kernel };
};

const waitForPending = async (approvals: ApprovalRegistry) => {
  for (let attempt = 0; attempt < 50; attempt++) {
    const pending = await Effect.runPromise(approvals.pending());
    if (pending.length > 0) return pending[0];
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("approval was never registered");
};

const replay = async (
  eventLog: ReturnType<typeof makeEventLog>,
): Promise<RecordedEvent[]> => {
  const events: RecordedEvent[] = [];
  for await (const event of eventLog.replay("session")) events.push(event);
  return events;
};

Deno.test("Kernel approval resolves once and records both lifecycle events", async () => {
  const { approvals, eventLog, kernel } = await makeFixture();
  const fiber = Effect.runFork(
    kernel.askForApproval("session", "call", "bash", { command: "pwd" }),
  );
  const pending = await waitForPending(approvals);

  const resolved = {
    approvalId: pending.approvalId,
    decision: "once" as const,
  };
  assertEquals(
    await Effect.runPromise(
      kernel.resolveApproval(pending.approvalId, resolved),
    ),
    true,
  );
  assertEquals(await Effect.runPromise(Fiber.join(fiber)), resolved);
  assertEquals(await Effect.runPromise(approvals.pending()), []);

  const events = await replay(eventLog);
  assertEquals(
    events.filter((event) =>
      event.type === "approval.requested" ||
      event.type === "approval.resolved"
    ).map((event) => event.type),
    ["approval.requested", "approval.resolved"],
  );
});

Deno.test("Kernel approval interruption rejects, cleans pending state, and cannot resolve late", async () => {
  const { approvals, eventLog, kernel } = await makeFixture();
  const fiber = Effect.runFork(
    kernel.askForApproval("session", "call", "write", { path: "a.txt" }),
  );
  const pending = await waitForPending(approvals);

  await Effect.runPromise(Fiber.interrupt(fiber));
  assertEquals(await Effect.runPromise(approvals.pending()), []);
  assertEquals(
    await Effect.runPromise(
      kernel.resolveApproval(pending.approvalId, {
        approvalId: pending.approvalId,
        decision: "once",
      }),
    ),
    false,
  );

  const resolved = (await replay(eventLog)).findLast((event) =>
    event.type === "approval.resolved"
  );
  assertEquals(resolved?.type, "approval.resolved");
  if (resolved?.type === "approval.resolved") {
    assertEquals(resolved.data, {
      approvalId: pending.approvalId,
      decision: "reject",
      feedback: "aborted",
    });
  }
});
