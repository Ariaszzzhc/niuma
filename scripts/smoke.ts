// Network-free end-to-end smoke test for the niuma CLI.
//
// What this proves:
//   - The full main-thread → Worker tunnel → Hono app → Effect runtime →
//     agent loop → tool pipeline → bash/read tool path is wired and runs.
//   - The MockProvider (injected via the CLI's --mock-provider flag, which
//     forwards to the worker over the tunnel init message) drives a scripted
//     flow without touching the network. The "run the smoke with subagent"
//     prompt selects the extended script: read → bash → spawn_subagent →
//     final text, so the real pipeline runs a child session end-to-end.
//   - The MANUAL permission UX works end-to-end: bash and spawn_subagent
//     trigger approval.requested events, the CLI reads "y" lines from stdin,
//     the approvals are resolved, and the tools execute.
//   - Subagent observability: the parent journal records subagent.spawned
//     (with callId) and subagent.completed (ok/usage/durationMs), and the
//     child's own journal is complete with parentSessionId lineage.
//   - The Workspace-scoped Session Journal is the only Session truth and
//     contains durable Model Call usage facts.
//
// Run: `deno run --allow-all scripts/smoke.ts`

import { fromFileUrl, join } from "@std/path";
import { workspaceKeyFromAbsolutePath } from "../packages/server/src/workspace_layout.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

interface SmokeFailure extends Error {
  phase: string;
}
const fail = (phase: string, message: string): never => {
  const e = new Error(`[smoke:${phase}] ${message}`);
  (e as SmokeFailure).phase = phase;
  throw e;
};

const main = async (): Promise<void> => {
  // ---- 1. Fresh temp dirs: workspace + NIUMA_DATA_DIR override. ----
  const dataDir = await Deno.makeTempDir({ prefix: "niuma-smoke-data-" });
  const workspace = await Deno.makeTempDir({ prefix: "niuma-smoke-ws-" });
  // README-smoke.txt is the file turn 1's `read` tool call targets.
  await Deno.writeTextFile(
    join(workspace, "README-smoke.txt"),
    "hello smoke\nthis file exists for the niuma smoke test.\n",
  );

  // ---- 2. Spawn the real CLI via `deno task cli`. ----
  // The `--` separator that the task description suggests does not work with
  // `deno task` (parseArgs treats it as a positional-only divider and drops
  // the subsequent -p flag), so we pass args directly.
  //
  // cwd stays at ROOT so `deno task` can locate deno.json; the workspace the
  // agent sees is set explicitly via --workspace so the read tool resolves
  // ./README-smoke.txt against the temp workspace we just seeded.
  const args = [
    "task",
    "cli",
    "-p",
    "run the smoke with subagent",
    "--workspace",
    workspace,
    "--mock-provider",
  ];
  console.error(`[smoke] spawning: deno ${args.join(" ")}`);
  console.error(`[smoke] workspace: ${workspace}`);
  console.error(`[smoke] data dir: ${dataDir}`);

  const cmd = new Deno.Command("deno", {
    args,
    cwd: ROOT,
    env: {
      ...Deno.env.toObject(),
      // Isolate the run from the developer's real ~/.niuma: Session Journals,
      // Usage Archives, and logs all land under the temp dir. The mock
      // provider means no config.toml / auth.json is consulted either.
      NIUMA_DATA_DIR: dataDir,
      // Prove the explicit --workspace wins over stale inherited process
      // state instead of writing the Journal under the wrong Workspace Key.
      NIUMA_WORKSPACE: join(workspace, "stale-inherited-workspace"),
    },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();

  // ---- 3. Feed "y\ny\n" to stdin for the bash + spawn_subagent approvals. ----
  // The CLI's promptApproval reads byte-by-byte and returns once it sees the
  // newline. Exactly two approvals arrive (turn 2's bash, then turn 3's
  // spawn_subagent; turn 1's read is in READ_ONLY_TOOLS and auto-allowed, and
  // the spawned child calls no tools), so two "y" lines are sufficient.
  const writer = child.stdin.getWriter();
  await writer.write(ENCODER.encode("y\ny\n"));
  // Closing stdin signals EOF — the CLI only reads stdin inside promptApproval,
  // so this is safe and prevents the reader from blocking on a second prompt.
  await writer.close();

  // ---- 4. Drain stdout + stderr concurrently while waiting for exit. ----
  const stdoutPromise = drainStream(child.stdout);
  const stderrPromise = drainStream(child.stderr);
  const status = await child.status;
  const stdout = DECODER.decode(await stdoutPromise);
  const stderr = DECODER.decode(await stderrPromise);

  if (stderr.length > 0) {
    console.error(`[smoke] cli stderr:\n${indent(stderr)}`);
  }
  console.error(`[smoke] cli exit code: ${status.code}`);
  console.error(`[smoke] cli stdout:\n${indent(stdout)}`);

  // ---- 5. Assertions. ----
  if (status.code !== 0) {
    fail("exit", `expected exit 0, got ${status.code}`);
  }
  if (!stdout.includes("smoke done")) {
    fail("stdout", `expected stdout to contain "smoke done"; got: ${stdout}`);
  }

  // ---- 6. Inspect the current Workspace's Session Journals. ----
  const workspaceKey = workspaceKeyFromAbsolutePath(workspace);
  const sessionsDir = join(dataDir, "sessions", workspaceKey);
  const jsonlFiles: string[] = [];
  try {
    for await (const entry of Deno.readDir(sessionsDir)) {
      if (entry.isFile && entry.name.endsWith(".jsonl")) {
        jsonlFiles.push(join(sessionsDir, entry.name));
      }
    }
  } catch (e) {
    fail("jsonl", `failed to list ${sessionsDir}: ${(e as Error).message}`);
  }
  // The run writes two journals: the top-level session and the spawned child.
  if (jsonlFiles.length < 2) {
    fail(
      "jsonl",
      `expected >=2 .jsonl files (parent + child) in ${sessionsDir}, got ${jsonlFiles.length}`,
    );
  }
  // Parse every journal and pick the parent by its first line: a top-level
  // session.created carries no parentSessionId, the child's does. (mtime is
  // too coarse to order journals written within the same millisecond.)
  interface ParsedJournal {
    readonly path: string;
    readonly events: Array<{
      type: string;
      sessionId?: string;
      data?: unknown;
    }>;
  }
  const journals: ParsedJournal[] = [];
  for (const path of jsonlFiles) {
    const text = await Deno.readTextFile(path);
    const events: ParsedJournal["events"][number][] = [];
    for (const line of text.split("\n").filter((l) => l.length > 0)) {
      try {
        events.push(JSON.parse(line));
      } catch (e) {
        fail(
          "jsonl",
          `non-JSON line in ${path}: ${line} (${(e as Error).message})`,
        );
      }
    }
    journals.push({ path, events });
  }
  const createdData = (j: ParsedJournal): { parentSessionId?: string } =>
    (j.events[0]?.type === "session.created" ? j.events[0].data ?? {} : {}) as {
      parentSessionId?: string;
    };
  const parent = journals.find((j) =>
    createdData(j).parentSessionId === undefined
  );
  if (!parent) {
    fail("jsonl", "no top-level Session Journal found");
  }
  console.error(`[smoke] parent Session Journal: ${parent.path}`);

  const events = parent.events;
  const types = new Set(events.map((e) => e.type));
  const requiredTypes = [
    "session.created",
    "model.call.completed",
    "tool.call.requested",
    "tool.result",
    "turn.completed",
  ];
  for (const rt of requiredTypes) {
    if (!types.has(rt)) {
      fail(
        "jsonl",
        `Session Journal missing required type "${rt}"; present types: ${
          Array.from(types).sort().join(", ")
        }`,
      );
    }
  }
  const sessionId = events.find((e) => e.type === "session.created")?.sessionId;
  if (!sessionId) {
    fail("jsonl", "session.created event had no sessionId");
  }
  console.error(`[smoke] session id: ${sessionId}`);
  console.error(
    `[smoke] event types present: ${Array.from(types).sort().join(", ")}`,
  );
  const modelCalls = events.filter((e) => e.type === "model.call.completed");
  if (modelCalls.length < 3) {
    fail(
      "jsonl",
      `expected >=3 model.call.completed events, got ${modelCalls.length}`,
    );
  }

  // ---- 6b. Verify tool result content — read fetched the README, bash ran echo. ----
  // Both checks prove the pipeline actually executed the tool bodies (not just
  // recorded the requests). The MockProvider ignores tool results, but the
  // assertion here catches a regression where the tool path is short-circuited.
  const toolResults = events.filter((e) => e.type === "tool.result") as Array<{
    type: string;
    data: { callId: string; content: unknown; isError: boolean };
  }>;
  if (toolResults.length < 2) {
    fail(
      "jsonl",
      `expected >=2 tool.result events, got ${toolResults.length}`,
    );
  }
  const readResult = toolResults.find((r) =>
    r.data.callId === "call_mock_read"
  );
  const bashResult = toolResults.find((r) =>
    r.data.callId === "call_mock_bash"
  );
  if (!readResult) fail("jsonl", "missing tool.result for call_mock_read");
  if (!bashResult) fail("jsonl", "missing tool.result for call_mock_bash");
  const readContent = stringifyContent(readResult!.data.content);
  const bashContent = stringifyContent(bashResult!.data.content);
  if (readResult!.data.isError || !readContent.includes("hello smoke")) {
    fail(
      "jsonl",
      `read tool did not yield README-smoke.txt content (isError=${
        readResult!.data.isError
      }); content: ${readContent}`,
    );
  }
  if (bashResult!.data.isError || !bashContent.includes("hello-from-niuma")) {
    fail(
      "jsonl",
      `bash tool did not yield "hello-from-niuma" (isError=${
        bashResult!.data.isError
      }); content: ${bashContent}`,
    );
  }
  console.error(`[smoke] read result: ${truncate(readContent, 80)}`);
  console.error(`[smoke] bash result: ${truncate(bashContent, 80)}`);

  // ---- 6c. Subagent observability: lineage + completion on the parent
  // journal, a complete child journal, and the child's final text as the
  // spawn_subagent tool result. ----
  const spawned = events.find((e) => e.type === "subagent.spawned");
  if (!spawned) fail("jsonl", "missing subagent.spawned");
  const spawnedData = spawned!.data as {
    childSessionId?: string;
    callId?: string;
    name?: string;
  };
  if (spawnedData.callId !== "call_mock_spawn") {
    fail(
      "jsonl",
      `subagent.spawned callId mismatch: ${spawnedData.callId}`,
    );
  }
  if (spawnedData.name !== "smoke-child") {
    fail(
      "jsonl",
      `subagent.spawned name mismatch: ${spawnedData.name}`,
    );
  }
  const completed = events.find((e) => e.type === "subagent.completed");
  if (!completed) fail("jsonl", "missing subagent.completed");
  const completedData = completed!.data as {
    ok?: boolean;
    childSessionId?: string;
    usage?: { inputTokens: number; outputTokens: number } | null;
    durationMs?: number;
  };
  if (
    completedData.ok !== true ||
    completedData.childSessionId !== spawnedData.childSessionId
  ) {
    fail(
      "jsonl",
      `subagent.completed mismatch: ${JSON.stringify(completedData)}`,
    );
  }
  const childJournal = journals.find((j) =>
    j.events[0]?.sessionId === spawnedData.childSessionId
  );
  if (!childJournal) {
    fail(
      "jsonl",
      `child Session Journal ${spawnedData.childSessionId} not found`,
    );
  }
  if (childJournal.events[0]?.type !== "session.created") {
    fail("jsonl", "child journal missing session.created");
  }
  if (createdData(childJournal).parentSessionId !== sessionId) {
    fail(
      "jsonl",
      `child session.created parentSessionId: ${
        JSON.stringify(createdData(childJournal))
      }`,
    );
  }
  const spawnResult = toolResults.find((r) =>
    r.data.callId === "call_mock_spawn"
  );
  if (!spawnResult) fail("jsonl", "missing tool.result for call_mock_spawn");
  const spawnContent = stringifyContent(spawnResult!.data.content);
  if (spawnResult!.data.isError || !spawnContent.includes("smoke child done")) {
    fail(
      "jsonl",
      `spawn_subagent result unexpected (isError=${
        spawnResult!.data.isError
      }): ${spawnContent}`,
    );
  }
  console.error(
    `[smoke] subagent: child ${spawnedData.childSessionId} ok, usage ${
      JSON.stringify(completedData.usage)
    }`,
  );

  // ---- 7. Assert the removed SQLite sidecar is not recreated. ----
  const dbPath = join(dataDir, "niuma.db");
  try {
    await Deno.stat(dbPath);
    fail("storage", `obsolete SQLite file was created: ${dbPath}`);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }

  console.error(`[smoke] PASS — cleanup: rm -rf ${dataDir} ${workspace}`);
  // Best-effort cleanup; do not fail the test if the OS blocks it.
  await Deno.remove(dataDir, { recursive: true }).catch(() => {});
  await Deno.remove(workspace, { recursive: true }).catch(() => {});
};

const drainStream = async (
  stream: ReadableStream<Uint8Array> | null,
): Promise<Uint8Array> => {
  if (!stream) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return merged;
};

const indent = (s: string): string =>
  s.split("\n").map((l) => `  ${l}`).join("\n");

// ToolResultContent is either a string or an array of {type:"text", text:string}.
const stringifyContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b): string =>
        typeof b === "object" && b !== null &&
          typeof (b as { text?: unknown }).text === "string"
          ? (b as { text: string }).text
          : String(b)
      )
      .join("\n");
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
};

const truncate = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n)}…` : s;

if (import.meta.main) {
  await main();
}
