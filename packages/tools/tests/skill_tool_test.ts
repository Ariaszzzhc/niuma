import { assert, assertEquals } from "@std/assert";
import type { SkillDef } from "@niuma/config";
import { makeSkillTool } from "../src/tools/skill.ts";
import { ToolRegistry } from "../src/registry.ts";
import type { ToolCtx } from "../src/types.ts";

const fakeCtx = (): ToolCtx => ({
  callId: "call-1",
  cwd: "/w",
  sessionId: "s1",
  signal: new AbortController().signal,
  ask: () => Promise.resolve({ decision: "reject" as const }),
});

const def = (name: string, body: string): SkillDef => ({
  name,
  description: `${name} desc`,
  body,
  dir: `/skills/${name}`,
  source: "user",
});

const toolWith = (
  defs: ReadonlyArray<SkillDef>,
): ReturnType<typeof makeSkillTool> =>
  makeSkillTool(new Map(defs.map((d) => [d.name, d])));

Deno.test("skill: hit returns the wrapped body verbatim without args", async () => {
  const tool = toolWith([def("review", "Review this code.")]);
  const out = await tool.execute({ name: "review" }, fakeCtx());
  assertEquals(out.isError, undefined);
  assertEquals(
    out.content,
    `<skill name="review" dir="/skills/review">\n` +
      `Review this code.\n` +
      `</skill>\n\n` +
      `Relative paths in the skill body resolve against the dir above.`,
  );
});

Deno.test("skill: empty or whitespace args leave the body untouched", async () => {
  const tool = toolWith([def("review", "Do $ARGUMENTS!")]);
  for (const args of [undefined, "", "   "]) {
    const out = await tool.execute({ name: "review", args }, fakeCtx());
    assert(
      out.content.includes("Do $ARGUMENTS!"),
      `args=${JSON.stringify(args)}: ${out.content}`,
    );
  }
});

Deno.test("skill: $ARGUMENTS expands the whole args string", async () => {
  const tool = toolWith([def("review", "Review $ARGUMENTS now.")]);
  const out = await tool.execute(
    { name: "review", args: "src/foo.ts --deep" },
    fakeCtx(),
  );
  assert(out.content.includes("Review src/foo.ts --deep now."));
});

Deno.test("skill: positional $1/$2 expand, highest swallows the rest", async () => {
  const tool = toolWith([def("ask", "ask $1 about $2")]);
  const out = await tool.execute(
    { name: "ask", args: "bob the quick brown fox" },
    fakeCtx(),
  );
  assert(out.content.includes("ask bob about the quick brown fox"));
});

Deno.test("skill: no placeholders — args appended after a blank line", async () => {
  const tool = toolWith([def("sum", "Summarize.")]);
  const out = await tool.execute(
    { name: "sum", args: "src/a.ts src/b.ts" },
    fakeCtx(),
  );
  assert(out.content.includes("Summarize.\n\nsrc/a.ts src/b.ts"));
});

Deno.test("skill: miss is an error listing available names (capped at 20)", async () => {
  const many = Array.from(
    { length: 25 },
    (_, i) => def(`s${String(i + 1).padStart(2, "0")}`, "x"),
  );
  const tool = toolWith(many);
  const out = await tool.execute({ name: "missing" }, fakeCtx());
  assertEquals(out.isError, true);
  assert(out.content.includes("skill not found: missing"));
  assert(out.content.includes("s01"), out.content);
  assert(out.content.includes("s20"), out.content);
  // Sorted listing is truncated at 20 names.
  assert(!out.content.includes("s21"), out.content);
});

Deno.test("skill: miss with an empty map reports (none)", async () => {
  const tool = toolWith([]);
  const out = await tool.execute({ name: "anything" }, fakeCtx());
  assertEquals(out.isError, true);
  assert(out.content.includes("available skills: (none)"));
});

Deno.test("skill: registered tools are exposed in read-only mode", () => {
  const registry = new ToolRegistry();
  registry.register("skill", toolWith([]));
  const names = registry.all("read-only").map((t) => t.name);
  assert(names.includes("skill"));
  // …and stays out of the way of the full mode's builtin set.
  assert(registry.all().some((t) => t.name === "skill"));
});

Deno.test("skill: normalize renders skill(<name>)", () => {
  const tool = toolWith([]);
  assertEquals(tool.normalize?.({ name: "review" }), "skill(review)");
});
