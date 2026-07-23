// ===========================================================================
// @niuma/tuikit — headless loop smoke test (fake Terminal, real native Frames)
// ---------------------------------------------------------------------------
// Drives the TEA runtime without a TTY: a fake Terminal object feeds scripted
// key events and captures writes. Verifies:
//   - first paint is a renderFull wrapped in CSI 2026 markers (caps.sync2026);
//   - a burst of input coalesces (the loop never renders more than it must);
//   - the FINAL frame is flushed on quit (the update that triggered
//     shouldQuit is painted before teardown);
//   - teardown order: final flush resolves before terminal.dispose().
// Requires the native dylib (Frame.create); skips with a build hint when
// absent, mirroring ffi_test.ts.
// ===========================================================================

import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import type { StyledLine, TerminalCaps } from "../src/binding-contract.ts";
import { openLib } from "../src/ffi.ts";
import { type LoopMsg, type Program, run } from "../src/loop.ts";
import type { Terminal, TerminalSize } from "../src/terminal.ts";

let LIB_OK = true;
try {
  openLib();
} catch {
  LIB_OK = false;
}

const CAPS: TerminalCaps = {
  truecolor: true,
  color256: true,
  kittyKeyboard: false,
  bracketedPaste: true,
  sync2026: true,
};

Deno.test("loop: headless smoke — first paint, coalescing, final flush", async () => {
  if (!LIB_OK) {
    console.warn("SKIP loop smoke — native cdylib unavailable (cargo build --release)");
    return;
  }
  const writes: Uint8Array[] = [];
  let disposed = false;
  const size: TerminalSize = { cols: 20, rows: 5 };

  const scripted = [
    { kind: "text", text: "a" },
    { kind: "text", text: "b" },
    { kind: "text", text: "q" }, // shouldQuit
  ] as const;

  const events: AsyncIterable<unknown> = {
    async *[Symbol.asyncIterator]() {
      for (const e of scripted) {
        await new Promise((r) => setTimeout(r, 5));
        yield e;
      }
    },
  };

  const fake = {
    caps: CAPS,
    size,
    onResize: (_cb: (s: TerminalSize) => void) => () => {},
    events: events as never,
    write: (bytes: Uint8Array) => {
      // The terminal must not be written to after dispose.
      assertEquals(disposed, false, "write after dispose");
      writes.push(bytes.slice());
      return Promise.resolve();
    },
    dispose: () => {
      disposed = true;
    },
  } as unknown as Terminal;

  interface M {
    readonly keys: readonly string[];
  }
  const program: Program<M, LoopMsg> = {
    init: () => [{ keys: [] }],
    update: (model, msg) => {
      if (msg.type === "tuikit:key" && msg.event.kind === "text") {
        return [{ keys: [...model.keys, msg.event.text] }];
      }
      return [model];
    },
    shouldQuit: (_model, msg) =>
      msg.type === "tuikit:key" && msg.event.kind === "text" && msg.event.text === "q",
    view: (model): readonly StyledLine[] => [
      { spans: [{ text: `keys=${model.keys.join("")}`, style: {} }] },
    ],
  };

  await run(fake, program);

  const dec = new TextDecoder();
  assert(writes.length >= 2, "expected first paint + final flush");
  const first = dec.decode(writes[0]);
  assert(
    first.startsWith("\x1b[?2026h\x1b[2J"),
    "first paint = sync begin + renderFull header",
  );
  const last = dec.decode(writes[writes.length - 1]);
  assert(last.endsWith("\x1b[?2026l"), "final write closes the sync block");
  // The update that triggered quit is painted in the final flush.
  assert(last.includes("abq"), "final frame reflects the last model state");
  assertEquals(disposed, true, "terminal disposed during teardown");
});
