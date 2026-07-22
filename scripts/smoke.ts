// Network-free end-to-end smoke test for the niuma CLI.
//
// What this proves:
//   - The full main-thread → Worker tunnel → Hono app → Effect runtime →
//     agent loop → tool pipeline → bash/read tool path is wired and runs.
//   - The MockProvider (NIUMA_MOCK_PROVIDER=1) drives a scripted 3-turn flow
//     without touching the network: read → bash → final text.
//   - The MANUAL permission UX works end-to-end: bash triggers an
//     approval.requested event, the CLI reads "y\n" from stdin, the
//     approval is resolved, and the bash tool executes.
//   - The JSONL event log (source of truth) and the SQLite projection
//     (niuma.db) both reflect the run.
//
// Run: `deno run --allow-all scripts/smoke.ts`

import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";

const ROOT = new URL("..", import.meta.url).pathname;
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
    "run the smoke",
    "--workspace",
    workspace,
  ];
  console.error(`[smoke] spawning: deno ${args.join(" ")}`);
  console.error(`[smoke] workspace: ${workspace}`);
  console.error(`[smoke] data dir: ${dataDir}`);

  const cmd = new Deno.Command("deno", {
    args,
    cwd: ROOT,
    env: {
      ...Deno.env.toObject(),
      NIUMA_MOCK_PROVIDER: "1",
      NIUMA_DATA_DIR: dataDir,
      // Mute logtape's INFO banner so stderr stays readable.
      NIUMA_LOG: "warning",
    },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();

  // ---- 3. Feed "y\n" to stdin for the bash approval. ----
  // The CLI's promptApproval reads byte-by-byte and returns once it sees the
  // newline. Only one approval arrives (turn 2's bash; turn 1's read is in
  // READ_ONLY_TOOLS and auto-allowed), so a single "y\n" is sufficient.
  const writer = child.stdin.getWriter();
  await writer.write(ENCODER.encode("y\n"));
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

  // ---- 6. Inspect the JSONL event log. ----
  const sessionsDir = join(dataDir, "sessions");
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
  if (jsonlFiles.length === 0) {
    fail("jsonl", `no .jsonl files in ${sessionsDir}`);
  }
  // Pick the newest by mtime — usually there is exactly one for a fresh data dir.
  let newest = jsonlFiles[0]!;
  for (const p of jsonlFiles) {
    if ((await Deno.stat(p)).mtime! > (await Deno.stat(newest)).mtime!) {
      newest = p;
    }
  }
  console.error(`[smoke] newest session log: ${newest}`);

  const text = await Deno.readTextFile(newest);
  const lines = text.split("\n").filter((l) => l.length > 0);
  const events: Array<{ type: string; sessionId?: string; data?: unknown }> = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch (e) {
      fail("jsonl", `non-JSON line in ${newest}: ${line} (${(e as Error).message})`);
    }
  }
  const types = new Set(events.map((e) => e.type));
  const requiredTypes = [
    "session.created",
    "tool.call.requested",
    "tool.result",
    "turn.completed",
  ];
  for (const rt of requiredTypes) {
    if (!types.has(rt)) {
      fail(
        "jsonl",
        `event log missing required type "${rt}"; present types: ${
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
  console.error(`[smoke] event types present: ${Array.from(types).sort().join(", ")}`);

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
  const readResult = toolResults.find((r) => r.data.callId === "call_mock_read");
  const bashResult = toolResults.find((r) => r.data.callId === "call_mock_bash");
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

  // ---- 7. Inspect niuma.db sessions table. ----
  const dbPath = join(dataDir, "niuma.db");
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    fail("db", `failed to open ${dbPath}: ${(e as Error).message}`);
  }
  try {
    const row = db!
      .prepare("SELECT session_id, workspace, status FROM sessions WHERE session_id = ?")
      .get(sessionId!) as
      | { session_id: string; workspace: string; status: string }
      | undefined;
    if (!row) {
      fail("db", `no row in sessions for sessionId=${sessionId}`);
    }
    console.error(`[smoke] db row: ${JSON.stringify(row)}`);
    if (row!.session_id !== sessionId) {
      fail("db", `session_id mismatch: ${row!.session_id} vs ${sessionId}`);
    }
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
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
        typeof b === "object" && b !== null && typeof (b as { text?: unknown }).text === "string"
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
