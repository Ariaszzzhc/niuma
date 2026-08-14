import { assertEquals } from "@std/assert";
import { spawnSubagentTool } from "../src/tools/spawn_subagent.ts";
import type { SubagentResult, ToolCtx } from "../src/types.ts";

const fakeCtx = (spawnSubagent: ToolCtx["spawnSubagent"]): ToolCtx => ({
  callId: "call-1",
  cwd: "/w",
  sessionId: "parent",
  signal: new AbortController().signal,
  ask: () => Promise.resolve({ decision: "reject" as const }),
  spawnSubagent,
});

Deno.test("spawn_subagent forwards callId and flags failed subagents as errors", async () => {
  let seen: unknown = null;
  const ctx = fakeCtx((req) => {
    seen = req;
    const r: SubagentResult = {
      sessionId: "child",
      text: "reason + trace",
      ok: false,
    };
    return Promise.resolve(r);
  });
  const out = await spawnSubagentTool.execute(
    { prompt: "do it", name: "doer" },
    ctx,
  );
  assertEquals(seen, {
    prompt: "do it",
    name: "doer",
    mode: "default",
    parentSessionId: "parent",
    callId: "call-1",
  });
  assertEquals(out.content, "reason + trace");
  assertEquals(out.isError, true);
});

Deno.test("spawn_subagent success keeps isError unset", async () => {
  const ctx = fakeCtx(() =>
    Promise.resolve({
      sessionId: "child",
      text: "all done",
      ok: true,
    })
  );
  const out = await spawnSubagentTool.execute(
    { prompt: "do it", name: "doer" },
    ctx,
  );
  assertEquals(out.content, "all done");
  assertEquals(out.isError, undefined);
});
