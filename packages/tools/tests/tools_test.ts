import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { Effect } from "effect";
import {
  applyPatchTool,
  bashTool,
  builtins,
  dataDir,
  editTool,
  globTool,
  grepTool,
  makeToolPipeline,
  matchWildcard,
  MemoryPermissionEngine,
  parsePatch,
  questionTool,
  readTool,
  runPipeline,
  safeCallId,
  schedule,
  spawnSubagentTool,
  toolOutput,
  ToolRegistry,
  updatePlanTool,
  writeTool,
} from "@niuma/tools";
import type {
  ApprovalDecision,
  ApprovalInfo,
  PermissionEngine,
  ToolCallRecord,
  ToolCtx,
  ToolOutput,
} from "@niuma/tools";

Deno.test("builtins are 10 built-in tools", () => {
  assertEquals(builtins().length, 10);
});

Deno.test("ToolRegistry resolves subset and exposes toolDefs", () => {
  const reg = new ToolRegistry();
  const subset = reg.resolve(["read", "write", "bash"]);
  assertEquals(subset.length, 3);
  const defs = reg.toToolDefs(["bash"]);
  assertEquals(defs.length, 1);
  assertEquals(defs[0].name, "bash");
  assertEquals((defs[0].parameters as { type: string }).type, "object");
});

Deno.test("bash executes and surfaces non-zero exit as isError", async () => {
  const out = await bashTool.execute(
    { command: "echo hello; exit 0" },
    mkCtx(),
  );
  assertEquals(out.isError, undefined);
  assertStringIncludes(out.content, "hello");

  const err = await bashTool.execute({ command: "exit 7" }, mkCtx());
  assertEquals(err.isError, true);
  assertStringIncludes(err.content, "exit 7");
});

Deno.test("write/read round-trip", async () => {
  const tmp = await Deno.makeTempDir();
  const c = mkCtx({ cwd: tmp });
  const w = await writeTool.execute(
    { path: "sub/dir/file.txt", content: "hi there\nsecond line" },
    c,
  );
  assertEquals(w.isError, undefined);
  const r = await readTool.execute({ path: "sub/dir/file.txt" }, c);
  assertStringIncludes(r.content, "hi there");
});

Deno.test("edit preserves CRLF and enforces uniqueness", async () => {
  const tmp = await Deno.makeTempDir();
  const c = mkCtx({ cwd: tmp });
  await Deno.writeTextFile(`${tmp}/crlf.txt`, "a\r\nb\r\nc\r\n");
  const ok = await editTool.execute(
    { path: "crlf.txt", edits: [{ oldText: "b", newText: "B" }] },
    c,
  );
  assertEquals(ok.isError, undefined);
  const raw = await Deno.readTextFile(`${tmp}/crlf.txt`);
  assertStringIncludes(raw, "\r\n");
  assertStringIncludes(raw, "B");

  // Duplicate match without replaceAll → error.
  await Deno.writeTextFile(`${tmp}/dup.txt`, "x\nx\n");
  const dup = await editTool.execute(
    { path: "dup.txt", edits: [{ oldText: "x", newText: "y" }] },
    c,
  );
  assertEquals(dup.isError, true);
});

Deno.test("apply_patch: add + update + delete", () => {
  const patch = [
    "*** Begin Patch",
    "*** Add File: a.txt",
    "alpha",
    "beta",
    "*** Update File: b.txt",
    " unchanged",
    "-removed",
    "+added",
    "*** Delete File: c.txt",
    "*** End Patch",
  ].join("\n");
  const hunks = parsePatch(patch);
  assertEquals(hunks.length, 3);
  assertEquals(hunks[0].kind, "add");
  assertEquals(hunks[0].diffLines?.join("|"), "alpha|beta");
  assertEquals(hunks[1].kind, "update");
  assertEquals(hunks[2].kind, "delete");
});

Deno.test("apply_patch: end-to-end add/update/delete against tmp dir", async () => {
  const tmp = await Deno.makeTempDir();
  const c = mkCtx({ cwd: tmp });
  // seed
  await Deno.writeTextFile(`${tmp}/b.txt`, "keep\nremoved\n");
  const patch = [
    "*** Begin Patch",
    "*** Add File: a.txt",
    "alpha",
    "*** Update File: b.txt",
    "keep",
    "-removed",
    "+added",
    "*** Delete File: nope.txt",
    "*** End Patch",
  ].join("\n");
  const out = await applyPatchTool.execute({ patch }, c);
  assertEquals(out.isError, undefined);
  assertStringIncludes(out.content, "+ a.txt");
  assertStringIncludes(out.content, "~ b.txt");
  assertStringIncludes(out.content, "- nope.txt");
  const a = await Deno.readTextFile(`${tmp}/a.txt`);
  assertStringIncludes(a, "alpha");
  const b = await Deno.readTextFile(`${tmp}/b.txt`);
  assertStringIncludes(b, "added");
  assert(!b.includes("removed"), "removed should be gone");
});

Deno.test("grep walks JS fallback when rg absent", async () => {
  const tmp = await Deno.makeTempDir();
  await Deno.writeTextFile(`${tmp}/a.txt`, "foo\nbar\nbaz\n");
  await Deno.writeTextFile(`${tmp}/b.txt`, "qux\n");
  const out = await grepTool.execute(
    { pattern: "^ba", path: "." },
    mkCtx({ cwd: tmp }),
  );
  assertEquals(out.isError, undefined);
  assertStringIncludes(out.content, "bar");
});

Deno.test("glob walks JS fallback and sorts by mtime desc", async () => {
  const tmp = await Deno.makeTempDir();
  await Deno.writeTextFile(`${tmp}/old.txt`, "x");
  await new Promise((r) => setTimeout(r, 20));
  await Deno.writeTextFile(`${tmp}/new.txt`, "y");
  const out = await globTool.execute(
    { pattern: "*.txt", path: "." },
    mkCtx({ cwd: tmp }),
  );
  assertEquals(out.isError, undefined);
  const lines = out.content.split("\n");
  assertStringIncludes(lines[0], "new.txt");
});

Deno.test("update_plan persists and rejects >1 in_progress", async () => {
  const c = mkCtx();
  const ok = await updatePlanTool.execute(
    { items: [{ title: "a", status: "in_progress" }] },
    c,
  );
  assertEquals(ok.isError, undefined);
  const bad = await updatePlanTool.execute(
    {
      items: [
        { title: "a", status: "in_progress" },
        { title: "b", status: "in_progress" },
      ],
    },
    c,
  );
  assertEquals(bad.isError, true);
});

Deno.test("question routes through ctx.ask and rejects with feedback", async () => {
  const c = mkCtx({
    askImpl: async () => ({ decision: "reject", feedback: "skip it" }),
  });
  const out = await questionTool.execute({ question: "continue?" }, c);
  assertEquals(out.isError, true);
  assertStringIncludes(out.content, "skip it");
});

Deno.test("spawn_subagent wires ctx.spawnSubagent", async () => {
  const c = mkCtx({
    spawnImpl: async (req) => ({
      sessionId: "child-1",
      text: `done: ${req.prompt}`,
    }),
  });
  const out = await spawnSubagentTool.execute(
    { prompt: "find the answer" },
    c,
  );
  assertStringIncludes(out.content, "done: find the answer");
});

Deno.test("scheduler runs non-conflicting reads in parallel and preserves order", async () => {
  const results = await schedule(
    [
      { index: 0, id: "a", accesses: {}, run: async () => "A" },
      { index: 1, id: "b", accesses: {}, run: async () => "B" },
      { index: 2, id: "c", accesses: {}, run: async () => "C" },
    ],
    { signal: new AbortController().signal },
  );
  assertEquals(results, ["A", "B", "C"]);
});

Deno.test("scheduler queues conflicting writes", async () => {
  let active = 0;
  let maxActive = 0;
  const r = await schedule(
    [
      {
        index: 0,
        id: "a",
        accesses: { files: { write: ["/x"] } },
        run: async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await delay(30);
          active--;
          return "A";
        },
      },
      {
        index: 1,
        id: "b",
        accesses: { files: { write: ["/x"] } },
        run: async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await delay(10);
          active--;
          return "B";
        },
      },
    ],
    { signal: new AbortController().signal },
  );
  assertEquals(r, ["A", "B"]);
  assertEquals(maxActive, 1, "conflicting writes should serialise");
});

Deno.test({
  name:
    "scheduler aborts in-flight jobs and synthesises error after grace",
  // The stub run() deliberately ignores the abort signal (simulating a
  // misbehaving tool) and schedules a 5s timer that the synthetic-error
  // path never cleans up — that's the whole point of the grace mechanism.
  // Suppress the ops sanitizer rather than weaken the stub.
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const ctrl = new AbortController();
    const job = schedule(
      [
        {
          index: 0,
          id: "stubborn",
          accesses: {},
          run: async () => {
            await new Promise((r) => setTimeout(r, 5000));
            return { content: "should not happen" };
          },
        },
      ],
      { signal: ctrl.signal, abortGraceMs: 50 },
    );
    setTimeout(() => ctrl.abort(), 10);
    const [res] = await job;
    const errRes = res as { content: string; isError?: boolean };
    assertEquals(errRes.isError, true);
    assertStringIncludes(errRes.content, "ignored abort");
  },
});

Deno.test("engine remembers always rules and applies them", async () => {
  const engine = new MemoryPermissionEngine();
  await engine.remember({
    tool: "bash",
    pattern: "echo *",
    action: "allow",
  });
  const d = await engine.evaluate({
    callId: "1",
    sessionId: "s",
    name: "bash",
    pattern: "echo hello",
  });
  assertEquals(d.decision, "allow");
});

Deno.test("matchWildcard handles * and ?", () => {
  assertEquals(matchWildcard("npm run *", "npm run test"), true);
  assertEquals(matchWildcard("npm run *", "echo npm run test"), false);
  assertEquals(matchWildcard("file?.txt", "file1.txt"), true);
});

Deno.test("pipeline runs prepare/authorize/schedule/execute end-to-end", async () => {
  const reg = new ToolRegistry();
  const engine: PermissionEngine = {
    evaluate: async () => ({ decision: "allow" }),
    remember: async () => {},
    patternFor: (n) => n,
  };
  const tmp = await Deno.makeTempDir();
  const calls: ToolCallRecord[] = [
    { callId: "c1", name: "write", input: { path: "x.txt", content: "hi" } },
    { callId: "c2", name: "read", input: { path: "x.txt" } },
  ];
  const out = await runPipeline(calls, {
    tools: new Map(reg.all().map((t) => [t.name, t])),
    engine,
    ctx: mkCtx({ cwd: tmp }),
  });
  assertEquals(out.length, 2);
  assertEquals(out[0].isError, undefined);
  assertStringIncludes(out[1].content, "hi");
});

Deno.test("pipeline surfaces Ask routing via ctx.ask", async () => {
  const reg = new ToolRegistry();
  const engine = new MemoryPermissionEngine({ sensitiveTools: ["bash"] });
  const asks: ApprovalInfo[] = [];
  const c = mkCtx({
    cwd: Deno.cwd(),
    askImpl: async (info) => {
      asks.push(info);
      return { decision: "once" };
    },
  });
  const out = await runPipeline(
    [{ callId: "x", name: "bash", input: { command: "ls" } }],
    {
      tools: new Map(reg.all().map((t) => [t.name, t])),
      engine,
      ctx: c,
    },
  );
  assertEquals(asks.length, 1);
  assertEquals(asks[0].name, "bash");
  assertEquals(out[0].isError, undefined);
});

Deno.test("pipeline surfaces unknown tool as isError", async () => {
  const reg = new ToolRegistry();
  const engine: PermissionEngine = {
    evaluate: async () => ({ decision: "allow" }),
    remember: async () => {},
    patternFor: (n) => n,
  };
  const out = await runPipeline(
    [{ callId: "x", name: "nope", input: {} }],
    {
      tools: new Map(reg.all().map((t) => [t.name, t])),
      engine,
      ctx: mkCtx(),
    },
  );
  assertEquals(out[0].isError, true);
  assertStringIncludes(out[0].content, "unknown tool");
});

Deno.test("truncate spills to disk when output > 30KB", async () => {
  const big = "x".repeat(40 * 1024);
  const r = await toolOutput(big, "smoke-call-1");
  assert(r.spillPath !== undefined, "spillPath should be set");
  const onDisk = await Deno.readTextFile(r.spillPath!);
  assertEquals(onDisk.length, big.length);
});

Deno.test("dataDir resolves under ~/.config/niuma by default", () => {
  const dir = dataDir();
  assertStringIncludes(dir, ".config");
  assertStringIncludes(dir, "niuma");
});

Deno.test("safeCallId strips path separators and shell-meaningful chars", () => {
  assertEquals(safeCallId("read:s1:/etc/passwd"), "read_s1_etc_passwd");
  assertEquals(safeCallId("grep:s1:foo/*.ts"), "grep_s1_foo_.ts");
  assertEquals(safeCallId("smoke-call-1"), "smoke-call-1");
  assertEquals(safeCallId("////"), "call");
  // Long callIds are capped.
  const long = "a".repeat(400);
  assertEquals(safeCallId(long).length, 128);
});

Deno.test("truncate spills safely when callId contains slashes", async () => {
  const big = "x".repeat(40 * 1024);
  const r = await toolOutput(big, "read:sess:/etc/foo/bar.txt");
  assertEquals(r.spillPath !== undefined, true);
  const onDisk = await Deno.readTextFile(r.spillPath!);
  assertEquals(onDisk.length, big.length);
});

Deno.test("read-only mode drops mutating tools from the registry defs", () => {
  const reg = new ToolRegistry();
  const full = reg.toToolDefs({ mode: "full" });
  const ro = reg.toToolDefs({ mode: "read-only" });
  assertEquals(full.length, 10);
  // read-only allowlist: read, grep, glob, update_plan, question.
  assertEquals(ro.length, 5);
  const roNames = new Set(ro.map((t) => t.name));
  assertEquals(roNames.has("bash"), false);
  assertEquals(roNames.has("write"), false);
  assertEquals(roNames.has("edit"), false);
  assertEquals(roNames.has("apply_patch"), false);
  assertEquals(roNames.has("spawn_subagent"), false);
  assertEquals(roNames.has("read"), true);
});

Deno.test("pipeline read-only mode short-circuits mutating tools", async () => {
  const reg = new ToolRegistry();
  const engine: PermissionEngine = {
    evaluate: async () => ({ decision: "allow" }),
    remember: async () => {},
    patternFor: (n) => n,
  };
  const tmp = await Deno.makeTempDir();
  const out = await runPipeline(
    [{ callId: "c1", name: "write", input: { path: "x.txt", content: "hi" } }],
    {
      tools: new Map(reg.all().map((t) => [t.name, t])),
      engine,
      ctx: mkCtx({ cwd: tmp }),
      mode: "read-only",
    },
  );
  assertEquals(out[0].isError, true);
  assertStringIncludes(out[0].content, "read-only");
  // File must NOT have been written.
  let exists = true;
  try {
    await Deno.stat(`${tmp}/x.txt`);
  } catch {
    exists = false;
  }
  assertEquals(exists, false);
});

Deno.test("pipeline forces Ask when a path escapes the workspace", async () => {
  const reg = new ToolRegistry();
  // Engine would normally allow read tools (READ_ONLY_TOOLS allowlist).
  const engine = new MemoryPermissionEngine();
  const asks: ApprovalInfo[] = [];
  const tmp = await Deno.makeTempDir();
  // Try to read /tmp itself — outside the workspace root which is `tmp`.
  // Use an absolute path that's definitely outside.
  const outside = Deno.makeTempDirSync({ prefix: "niuma-escape-" });
  const out = await runPipeline(
    [{
      callId: "c1",
      name: "read",
      input: { path: `${outside}/secret.txt` },
    }],
    {
      tools: new Map(reg.all().map((t) => [t.name, t])),
      engine,
      ctx: mkCtx({
        cwd: tmp,
        askImpl: async (info) => {
          asks.push(info);
          return { decision: "reject", feedback: "no" };
        },
      }),
      workspaceRoot: tmp,
    },
  );
  assertEquals(asks.length, 1, "escape must trigger an Ask");
  assertEquals(asks[0].sensitive, true);
  assertEquals(out[0].isError, true);
  Deno.removeSync(outside, { recursive: true });
});

Deno.test("pipeline records durationMs and callId on every result", async () => {
  const reg = new ToolRegistry();
  const engine: PermissionEngine = {
    evaluate: async () => ({ decision: "allow" }),
    remember: async () => {},
    patternFor: (n) => n,
  };
  const tmp = await Deno.makeTempDir();
  const out = await runPipeline(
    [{ callId: "c-xyz", name: "write", input: { path: "y.txt", content: "z" } }],
    {
      tools: new Map(reg.all().map((t) => [t.name, t])),
      engine,
      ctx: mkCtx({ cwd: tmp }),
    },
  );
  assertEquals(out[0].callId, "c-xyz");
  assertEquals(typeof out[0].durationMs, "number");
  assertEquals((out[0].durationMs ?? -1) >= 0, true);
});

Deno.test("agent-port adapter: defs(mode) and run() round-trip", async () => {
  const pipeline = makeToolPipeline({ registry: new ToolRegistry() });
  const fullDefs = pipeline.defs("full");
  const roDefs = pipeline.defs("read-only");
  assertEquals(fullDefs.length, 10);
  assertEquals(roDefs.length, 5);

  const tmp = await Deno.makeTempDir();
  const results = await Effect.runPromise(pipeline.run(
    [
      {
        callId: "ac-1",
        name: "write",
        input: { path: "a.txt", content: "hello" },
      },
      {
        callId: "ac-2",
        name: "read",
        input: { path: "a.txt" },
      },
    ],
    {
      sessionId: "sess",
      workspace: tmp,
      mode: "full",
      ask: () => Effect.succeed({ decision: "once" as const }),
    },
  ));
  assertEquals(results.length, 2);
  assertEquals(results[0].callId, "ac-1");
  assertEquals(results[0].isError, false);
  assertEquals(results[0].durationMs >= 0, true);
  const readContent = results[1].content;
  assertStringIncludes(
    typeof readContent === "string" ? readContent : JSON.stringify(readContent),
    "hello",
  );
});

Deno.test("agent-port adapter: routes Ask through the Effect-returning ctx.ask", async () => {
  const pipeline = makeToolPipeline({ registry: new ToolRegistry() });
  const tmp = await Deno.makeTempDir();
  let asked = 0;
  const results = await Effect.runPromise(pipeline.run(
    [{ callId: "bash-1", name: "bash", input: { command: "ls" } }],
    {
      sessionId: "sess",
      workspace: tmp,
      mode: "full",
      ask: (req) =>
        Effect.sync(() => {
          asked++;
          assertEquals(req.name, "bash");
          return { decision: "once" as const };
        }),
    },
  ));
  assertEquals(asked, 1);
  assertEquals(results[0].isError, false);
});

Deno.test("MemoryPermissionEngine honours deny rules over allow rules", async () => {
  const engine = new MemoryPermissionEngine();
  await engine.remember({ tool: "bash", pattern: "rm *", action: "allow" });
  await engine.remember({ tool: "bash", pattern: "rm -rf *", action: "deny" });
  const deny = await engine.evaluate({
    callId: "1",
    sessionId: "s",
    name: "bash",
    pattern: "rm -rf /tmp",
  });
  assertEquals(deny.decision, "deny");
  const allow = await engine.evaluate({
    callId: "2",
    sessionId: "s",
    name: "bash",
    pattern: "rm file",
  });
  assertEquals(allow.decision, "allow");
});

Deno.test("scheduler serialises write/read on the same path", async () => {
  let active = 0;
  let maxActive = 0;
  const bump = () => {
    active++;
    maxActive = Math.max(maxActive, active);
  };
  const r = await schedule(
    [
      {
        index: 0,
        id: "w",
        accesses: { files: { write: ["/file"] } },
        run: async () => {
          bump();
          await delay(20);
          active--;
          return "W";
        },
      },
      {
        index: 1,
        id: "r",
        accesses: { files: { read: ["/file"] } },
        run: async () => {
          bump();
          await delay(5);
          active--;
          return "R";
        },
      },
    ],
    { signal: new AbortController().signal },
  );
  assertEquals(r, ["W", "R"]);
  assertEquals(maxActive, 1, "write/read on the same path must serialise");
});

// ---- helpers ----

interface MkOpts {
  cwd?: string;
  askImpl?: (info: ApprovalInfo) => Promise<ApprovalDecision>;
  spawnImpl?: (req: {
    prompt: string;
    mode?: "default" | "read-only";
    parentSessionId: string;
  }) => Promise<{ sessionId: string; text: string }>;
}

function mkCtx(overrides: MkOpts = {}): ToolCtx {
  return {
    cwd: overrides.cwd ?? Deno.cwd(),
    sessionId: "test-session",
    signal: new AbortController().signal,
    ask: overrides.askImpl ?? (async () => ({ decision: "once" })),
    spawnSubagent: overrides.spawnImpl,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function assertStringIncludes(haystack: string, needle: string) {
  assert(
    haystack.includes(needle),
    `expected ${JSON.stringify(haystack).slice(0, 80)} to include ${needle}`,
  );
}

// Silence unused warnings for ToolOutput in some build configurations.
const _t: ToolOutput | undefined = undefined;
const _ = _t;