import { assertEquals } from "@std/assert";
import { dirname } from "@std/path";
import { Effect } from "effect";
import { MemoryPermissionEngine, type PermissionEngine } from "@niuma/tools";
import { makeToolPipeline } from "../src/tool-pipeline.ts";
import { resultContentToString } from "../src/context.ts";
import type { ApprovalOutcome, ToolMode, ToolRunContext } from "../src/deps.ts";

const approvingEngine = (): PermissionEngine => {
  const inner = new MemoryPermissionEngine();
  return {
    evaluate: (req) => inner.evaluate(req),
    remember: (sessionId, rule) => inner.remember(sessionId, rule),
  };
};

const approvingCtx = (
  sessionId: string,
  workspace: string,
  mode: ToolMode,
): ToolRunContext => ({
  sessionId,
  workspace,
  mode,
  ask: (_req) => Effect.succeed<ApprovalOutcome>({ decision: "once" }),
});

Deno.test("tool-pipeline: defs expose only the shared read-only allowlist", () => {
  const pipe = makeToolPipeline({ engine: approvingEngine() });
  const full = pipe.defs("full").map((d) => d.name);
  const ro = pipe.defs("read-only").map((d) => d.name);
  for (const n of ["bash", "write", "edit", "apply_patch", "spawn_subagent"]) {
    assertEquals(full.includes(n), true);
    assertEquals(ro.includes(n), false);
  }
  assertEquals(ro.includes("read"), true);
});

Deno.test("tool-pipeline: read-only rejects mutating calls with synthetic error", async () => {
  const pipe = makeToolPipeline({ engine: approvingEngine() });
  const results = await Effect.runPromise(pipe.run(
    [{
      callId: "c1",
      name: "bash",
      input: { command: "echo hi" },
    }],
    approvingCtx("s", "/tmp", "read-only"),
  ));
  assertEquals(results.length, 1);
  assertEquals(results[0]!.isError, true);
  assertEquals(
    resultContentToString(results[0]!.content).includes("read-only"),
    true,
  );
});

Deno.test("tool-pipeline: read tool round-trip executes via runPipeline", async () => {
  const tmp = await Deno.makeTempFile();
  await Deno.writeTextFile(tmp, "hello world\n");
  const pipe = makeToolPipeline({ engine: approvingEngine() });
  const results = await Effect.runPromise(pipe.run(
    [{ callId: "c1", name: "read", input: { path: tmp } }],
    // Workspace is the temp file's own dir: "/" only contains everything on
    // Unix — on Windows it resolves to the current drive's root (e.g. D:\)
    // and the temp dir may live on another drive, tripping the escape check.
    approvingCtx("s", dirname(tmp), "full"),
  ));
  assertEquals(results.length, 1);
  assertEquals(results[0]!.isError, false);
  assertEquals(
    resultContentToString(results[0]!.content).includes("hello world"),
    true,
  );
});

Deno.test("tool-pipeline: question preserves provider call id and structured input", async () => {
  const pipe = makeToolPipeline({ engine: approvingEngine() });
  const input = {
    question: "Which option?",
    options: ["alpha", "beta"],
  };
  let asked:
    | {
      readonly callId: string;
      readonly name: string;
      readonly input: unknown;
    }
    | undefined;
  const ctx: ToolRunContext = {
    sessionId: "s",
    workspace: "/tmp",
    mode: "full",
    ask: (req) => {
      asked = req;
      return Effect.succeed<ApprovalOutcome>({
        decision: "once",
        feedback: "beta",
      });
    },
  };

  const results = await Effect.runPromise(pipe.run(
    [{ callId: "call-question-1", name: "question", input }],
    ctx,
  ));

  assertEquals(asked, {
    callId: "call-question-1",
    name: "question",
    input,
  });
  assertEquals(resultContentToString(results[0]!.content), "beta");
});

Deno.test("tool-pipeline: progress uses the provider call id", async () => {
  const pipe = makeToolPipeline({ engine: approvingEngine() });
  const progress: Array<{ callId: string; message?: string }> = [];
  const ctx: ToolRunContext = {
    ...approvingCtx("s", "/tmp", "full"),
    emitProgress: (callId, message) => progress.push({ callId, message }),
  };

  const results = await Effect.runPromise(pipe.run(
    [{
      callId: "call-plan-1",
      name: "update_plan",
      input: { items: [{ title: "Implement TUI", status: "in_progress" }] },
    }],
    ctx,
  ));

  assertEquals(results[0]!.isError, false);
  assertEquals(progress, [{
    callId: "call-plan-1",
    message: "plan updated: 1 items",
  }]);
});
