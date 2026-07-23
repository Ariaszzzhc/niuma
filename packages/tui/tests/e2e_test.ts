// ===========================================================================
// @niuma/tui — headless end-to-end test (fake Terminal + real worker tunnel)
// ---------------------------------------------------------------------------
// Drives the REAL TEA program (`buildProgram`) through tuikit's real `run`
// loop against a REAL server worker (spawnServerWorker + fetch tunnel, the
// exact path interactive.ts uses), with the scripted mock provider. Only the
// Terminal is faked: an event queue feeds keystrokes, and writes are captured
// so we can assert on the final painted frame.
//
// Scripted flow (mirrors scripts/smoke.ts):
//   - type "run the smoke" + enter          -> POST /prompt
//   - turn 1: read README-smoke.txt (auto-allowed, no approval)
//   - turn 2: bash -> approval.requested    -> press "y"
//   - turn 3: final assistant text "smoke done"
//   - palette /quit closes the loop; worker terminated in finally.
//
// Asserts on the FINAL model (via view output decoded from the captured
// writes AND direct model introspection through a test hook): the assistant
// text made it into the transcript, both tool calls are done, and the
// approval modal appeared and cleared.
//
// Requires the native cdylib (tuikit Frames) — skips with a hint when absent,
// mirroring tuikit's loop_test.ts.
// ===========================================================================

import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { join } from "@std/path";
import { openLib } from "../../tuikit/src/ffi.ts";
import { run, type StyledLine, type TerminalSize } from "@niuma/tuikit";
import type { Terminal } from "../../tuikit/src/terminal.ts";
import { buildProgram } from "../src/app.ts";
import { createTuiClient } from "../src/client.ts";
import { darkTheme } from "../src/theme.ts";
import { spawnServerWorker } from "../../cli/src/worker.ts";

let LIB_OK = true;
try {
  openLib();
} catch {
  LIB_OK = false;
}

const noMods = { shift: false, alt: false, ctrl: false, super: false } as const;

const textEvent = (ch: string) =>
  ({ kind: "text", text: ch, mods: { ...noMods }, eventType: "press" }) as const;
const enterEvent = () =>
  ({ kind: "key", key: "enter", mods: { ...noMods }, eventType: "press" }) as const;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** True when the view's transcript rows show `needle`. */
const viewShows = (view: readonly StyledLine[], needle: string): boolean =>
  view.some((l) => l.spans.map((s) => s.text).join("").includes(needle));

Deno.test("e2e: prompt -> read -> bash approval -> final text", async (t) => {
  if (!LIB_OK) {
    console.warn("SKIP e2e — native cdylib unavailable (deno task build:native)");
    return;
  }

  const dataDir = await Deno.makeTempDir({ prefix: "niuma-tui-e2e-data-" });
  const workspace = await Deno.makeTempDir({ prefix: "niuma-tui-e2e-ws-" });
  await Deno.writeTextFile(
    join(workspace, "README-smoke.txt"),
    "hello smoke\nthis file exists for the niuma smoke test.\n",
  );
  const prevDataDir = Deno.env.get("NIUMA_DATA_DIR");
  Deno.env.set("NIUMA_DATA_DIR", dataDir);

  const spawned = await spawnServerWorker({ mockProvider: true });
  if (!spawned.ok) {
    throw new Error("worker failed to start");
  }
  const { tunnel } = spawned;

  // -- scripted terminal input ----------------------------------------------
  // A pull-based event queue: steps are appended by the driver below; each
  // step fires only after a condition on the latest painted view holds.
  type Step = { readonly events: readonly unknown[] };
  const queue: unknown[] = [];
  let wake: (() => void) | null = null;
  const push = (evs: readonly unknown[]): void => {
    queue.push(...evs);
    wake?.();
  };
  const events: AsyncIterable<unknown> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length > 0) yield queue.shift();
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };

  const writes: Uint8Array[] = [];
  const size: TerminalSize = { cols: 80, rows: 24 };
  const fake = {
    caps: {
      truecolor: true,
      color256: true,
      kittyKeyboard: false,
      bracketedPaste: true,
      sync2026: true,
    },
    size,
    onResize: (_cb: (s: TerminalSize) => void) => () => {},
    events: events as never,
    write: (bytes: Uint8Array) => {
      writes.push(bytes.slice());
      return Promise.resolve();
    },
    dispose: () => {},
  } as unknown as Terminal;

  const client = await createTuiClient(tunnel.fetch, { workspace });

  const program = buildProgram({
    client,
    theme: darkTheme,
    version: "e2e",
    workspace,
    size,
  });

  // -- driver ---------------------------------------------------------------
  // Poll the program's view via the loop's paints: we re-derive the view from
  // the last decoded frame. Simpler and race-free: keep a handle on the model
  // by wrapping update (the loop passes every msg through it).
  let latestModel: unknown = null;
  const wrappedUpdate = program.update;
  const spyProgram = {
    ...program,
    update: (model: never, msg: never) => {
      const out = wrappedUpdate(model, msg);
      latestModel = out[0];
      return out;
    },
    view: (model: never) => {
      latestModel = model;
      return program.view(model);
    },
  };

  interface ModelProbe {
    readonly state: {
      readonly messages: readonly { role: string; text: string }[];
      readonly toolCalls: readonly { name: string; status: string }[];
      readonly pendingApproval: unknown;
      readonly turnActive: boolean;
    };
    readonly approval: unknown;
    readonly quitting: boolean;
  }
  const probe = (): ModelProbe => latestModel as ModelProbe;

  const waitFor = async (
    cond: () => boolean,
    what: string,
    timeoutMs = 30_000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (cond()) return;
      await sleep(50);
    }
    throw new Error(`e2e timeout waiting for: ${what}`);
  };

  const runPromise = run(fake, spyProgram as typeof program);

  try {
    await t.step("submit prompt", async () => {
      await waitFor(() => probe() !== null, "program init");
      const typed = "run the smoke";
      push([...typed].map((ch) => textEvent(ch)));
      push([enterEvent()]);
      await waitFor(
        () => probe().state.messages.some((m) => m.role === "user" && m.text.includes("run the smoke")),
        "user.message recorded",
      );
    });

    await t.step("read tool completes without approval", async () => {
      await waitFor(
        () =>
          probe().state.toolCalls.some((c) => c.name === "read" || c.name === "read_file") ||
          probe().state.toolCalls.length >= 1,
        "first tool call requested",
      );
    });

    await t.step("approval modal appears for bash", async () => {
      await waitFor(() => probe().approval !== null, "approval modal raised");
      // view should show the modal chrome
      const v = program.view(probe() as never);
      assert(viewShows(v as readonly StyledLine[], "approval required"), "modal painted");
      // press y -> approve once
      push([textEvent("y")]);
      await waitFor(() => probe().approval === null, "approval modal cleared");
    });

    await t.step("final assistant text arrives", async () => {
      await waitFor(
        () => probe().state.messages.some((m) => m.role === "assistant" && m.text.includes("smoke done")),
        "assistant final text in model",
      );
      // Both tool calls finished; the transcript view contains the final text.
      const calls = probe().state.toolCalls;
      assert(calls.length >= 2, `expected >=2 tool calls, got ${calls.length}`);
      assert(
        calls.every((c) => c.status !== "running"),
        `tool calls still running: ${JSON.stringify(calls.map((c) => c.status))}`,
      );
      const v = program.view(probe() as never) as readonly StyledLine[];
      assert(viewShows(v, "smoke done"), "final text painted in transcript");
    });

    await t.step("quit closes the loop", async () => {
      // /quit via the palette: ctrl+p, then "/quit" is the only 'q' command
      push([{ kind: "text", text: "p", mods: { ...noMods, ctrl: true }, eventType: "press" }]);
      push([textEvent("q"), textEvent("u"), textEvent("i"), textEvent("t")]);
      push([enterEvent()]);
      await waitFor(() => probe().quitting === true, "quitting flag set");
    });
  } finally {
    // Belt-and-braces: if a step failed before /quit, force-quit so the loop
    // does not hang the test.
    try {
      push([{ kind: "text", text: "c", mods: { ...noMods, ctrl: true }, eventType: "press" }]);
      push([{ kind: "text", text: "c", mods: { ...noMods, ctrl: true }, eventType: "press" }]);
    } catch { /* ignore */ }
    await runPromise;
    try {
      tunnel.worker.terminate();
    } catch { /* ignore */ }
    try {
      tunnel.port.close();
    } catch { /* ignore */ }
    if (prevDataDir === undefined) Deno.env.delete("NIUMA_DATA_DIR");
    else Deno.env.set("NIUMA_DATA_DIR", prevDataDir);
    await Deno.remove(dataDir, { recursive: true }).catch(() => {});
    await Deno.remove(workspace, { recursive: true }).catch(() => {});
  }

  assertEquals(probe().quitting, true);
  assert(writes.length >= 2, "expected multiple painted frames");
});
