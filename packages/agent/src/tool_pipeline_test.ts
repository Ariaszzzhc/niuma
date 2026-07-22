import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { Effect } from "effect";
import { MemoryPermissionEngine, type PermissionEngine } from "@niuma/tools";
import { makeToolPipeline } from "./tool_pipeline.ts";
import { resultContentToString } from "./context.ts";
import type {
  ApprovalOutcome,
  ToolMode,
  ToolRunContext,
} from "./deps.ts";

const approvingEngine = (): PermissionEngine => {
  const inner = new MemoryPermissionEngine({ sensitiveTools: [] });
  return {
    evaluate: (req) => inner.evaluate(req),
    remember: (r) => inner.remember(r),
    patternFor: (n, i) => inner.patternFor(n, i),
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
  ask: (_req) =>
    Effect.succeed<ApprovalOutcome>({ decision: "once" }),
});

Deno.test("tool_pipeline: defs drop bash/write/edit/apply_patch in read-only mode", () => {
  const pipe = makeToolPipeline({ engine: approvingEngine() });
  const full = pipe.defs("full").map((d) => d.name);
  const ro = pipe.defs("read-only").map((d) => d.name);
  for (const n of ["bash", "write", "edit", "apply_patch"]) {
    assertEquals(full.includes(n), true);
    assertEquals(ro.includes(n), false);
  }
  assertEquals(ro.includes("read"), true);
});

Deno.test("tool_pipeline: read-only rejects mutating calls with synthetic error", async () => {
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

Deno.test("tool_pipeline: read tool round-trip executes via runPipeline", async () => {
  const tmp = await Deno.makeTempFile();
  await Deno.writeTextFile(tmp, "hello world\n");
  const pipe = makeToolPipeline({ engine: approvingEngine() });
  const results = await Effect.runPromise(pipe.run(
    [{ callId: "c1", name: "read", input: { path: tmp } }],
    approvingCtx("s", "/", "full"),
  ));
  assertEquals(results.length, 1);
  assertEquals(results[0]!.isError, false);
  assertEquals(
    resultContentToString(results[0]!.content).includes("hello world"),
    true,
  );
});
