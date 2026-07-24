// ===========================================================================
// @niuma/tuikit — the TEA (The Elm Architecture) runtime
// ---------------------------------------------------------------------------
// Owns the render hot path the way the plan describes it:
//
//   stdin bytes -> (terminal.ts) KeyParser -> KeyMsg
//   KeyMsg / ResizeMsg / TickMsg / ErrorMsg  -> update(model, msg)
//   update returns [model, cmds]            -> cmd results re-queued as msgs
//   batch all pending msgs, then render ONCE
//   render: view(model) -> StyledLine[] -> next Frame (writeLine per row)
//           first paint: Frame.renderFull ; later: Frame.diff(prev, next)
//           the whole output is wrapped in CSI 2026 sync markers and written
//           to stdout as ONE Terminal.write (minimises flicker); Rust never
//           emits 2026 markers itself.
//
// Frame budget: ~30fps with trailing-edge coalescing. Multiple updates that
// land inside one frame interval collapse into a single render scheduled at
// the trailing edge, so a burst of key events paints once, not N times.
//
// Cmd rejections never kill the loop: a rejected cmd is caught and surfaced
// as an `ErrorMsg` (choice documented inline) so the app can react or log it
// while the loop keeps running.
//
// Quit: `program.shouldQuit?.(model, msg)` returning true stops the loop;
// on quit we flush pending writes, stop subscriptions, tear down the input
// pump, dispose the terminal (restores cursor / leaves alt-screen / cooked
// mode) and free both Frames.
//
// This module is all const arrow functions + one small internal queue class
// (a bag of mutable state, which is what classes are for).
// ===========================================================================

import type {
  Cmd,
  InputEvent,
  Program as ContractProgram,
  StyledLine,
} from "./binding_contract.ts";
import { Frame } from "./frame.ts";
import {
  SYNC_BEGIN,
  SYNC_END,
  type Terminal,
  type TerminalSize,
} from "./terminal.ts";

// ---------------------------------------------------------------------------
// Built-in messages the loop emits. A program's `Msg` should be a union that
// INCLUDES these (the demo uses `LoopMsg` verbatim). The loop casts its
// emitted messages to `Msg` at the queue boundary — Msg is intentionally not
// constrained, so apps can carry their own extra message variants alongside.
// ---------------------------------------------------------------------------

/** A decoded keyboard / paste event arrived from stdin. */
export interface KeyMsg {
  readonly type: "tuikit:key";
  readonly event: InputEvent;
}
/** The terminal was resized (SIGWINCH). The loop has already resized its Frames. */
export interface ResizeMsg {
  readonly type: "tuikit:resize";
  readonly size: TerminalSize;
}
/** A periodic tick fired (from a `tick()` subscription). `n` increments each fire. */
export interface TickMsg {
  readonly type: "tuikit:tick";
  readonly n: number;
}
/** A Cmd rejected; `error` is whatever it threw. The loop itself stays alive. */
export interface ErrorMsg {
  readonly type: "tuikit:error";
  readonly error: unknown;
}

/** Union of every message the runtime can produce on its own. */
export type LoopMsg = KeyMsg | ResizeMsg | TickMsg | ErrorMsg;

// ---------------------------------------------------------------------------
// Cmd / Sub / Program
// ---------------------------------------------------------------------------

/** Re-export of the contract's one-shot command type. */
export type { Cmd };

/**
 * A subscription: a recurring source of messages (timers, etc.). The loop
 * calls `subscribe(emit)` once at startup; `emit` posts a message into the
 * update queue. Returning an unsubscribe fn lets the loop tear it down on
 * quit. `tick()` is the canonical Sub.
 */
export interface Sub<Msg> {
  readonly subscribe: (emit: (msg: Msg) => void) => () => void;
}

/**
 * A TEA program. Extends the contract's `Program` with two OPTIONAL hooks:
 *  - `subscriptions(model)`: called ONCE with the initial model; the returned
 *    Subs live for the whole run (v1 — reactive re-subscription is not yet
 *    modelled). Powers `tick()`-driven animation.
 *  - `shouldQuit(model, msg)`: returning true stops the loop cleanly.
 */
export interface Program<Model, Msg> extends ContractProgram<Model, Msg> {
  readonly subscriptions?: (model: Model) => readonly Sub<Msg>[];
  readonly shouldQuit?: (model: Model, msg: Msg) => boolean;
}

/** Lift a plain async function into the `Cmd` shape (`null`/`undefined` -> no msg). */
export const cmd = <Msg>(
  fn: () => Promise<Msg | null | undefined>,
): Cmd<Msg> => ({
  run: async () => (await fn()) ?? undefined,
});

/**
 * Subscription that fires `msgFn(n)` every `intervalMs`. `n` increments from 1
 * on each fire. Use it for spinners / clocks / polling. Cleanup clears the
 * interval when the loop quits.
 */
export const tick = <Msg>(
  intervalMs: number,
  msgFn: (n: number) => Msg,
): Sub<Msg> => ({
  subscribe: (emit) => {
    let n = 0;
    const id = setInterval(() => emit(msgFn(++n)), intervalMs);
    return () => clearInterval(id);
  },
});

// ---------------------------------------------------------------------------
// Minimal single-consumer message queue with batch drain
// ---------------------------------------------------------------------------

class MsgQueue<Msg> {
  #buf: Msg[] = [];
  #waiters: Array<() => void> = [];
  #closed = false;

  push(m: Msg): void {
    if (this.#closed) return;
    this.#buf.push(m);
    const w = this.#waiters.shift();
    if (w) w();
  }

  /** Resolve when at least one message is buffered or the queue is closed. */
  wait(): Promise<void> {
    if (this.#buf.length > 0 || this.#closed) return Promise.resolve();
    return new Promise((res) => this.#waiters.push(res));
  }

  /** Take every currently-buffered message in one batch. */
  drain(): Msg[] {
    if (this.#buf.length === 0) return [];
    const out = this.#buf;
    this.#buf = [];
    return out;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const ws = this.#waiters;
    this.#waiters = [];
    for (const w of ws) w();
  }
}

// ---------------------------------------------------------------------------
// Render frame budget
// ---------------------------------------------------------------------------

const FRAME_MS = 1000 / 30; // ~30fps cap

/** Concatenate byte chunks into one Uint8Array (avoids per-write Node Buffer). */
const concatBytes = (parts: readonly Uint8Array[]): Uint8Array => {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
};

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

/**
 * Run a TEA program against an open `Terminal`. Resolves when `shouldQuit`
 * fires (or the input stream ends). Owns the Frame double-buffer and the
 * CSI-2026 wrapping; emits exactly one `Terminal.write` per rendered frame.
 */
export const run = async <Model, Msg>(
  terminal: Terminal,
  program: Program<Model, Msg>,
): Promise<void> => {
  const caps = terminal.caps;
  const startCols = terminal.size.cols;
  const startRows = terminal.size.rows;

  // Double buffer: build `next`, diff `prev -> next`, then swap. Both frames
  // track the terminal geometry and are resized together on SIGWINCH.
  let prev = Frame.create(startCols, startRows);
  let next = Frame.create(startCols, startRows);
  let firstRender = true; // full repaint on first paint and after a resize
  let model: Model;

  const queue = new MsgQueue<Msg>();
  let quit = false;

  // Serialise stdout writes so frames never interleave/reorder. Each render
  // chains onto the previous write; we await the chain before disposing.
  let writeChain: Promise<void> = Promise.resolve();
  const writeSerial = (bytes: Uint8Array): void => {
    if (bytes.length === 0) return;
    writeChain = writeChain.then(() => terminal.write(bytes));
  };

  /** Wrap a render body in CSI 2026 sync markers when the terminal supports it. */
  const wrapSync = (body: Uint8Array): Uint8Array => {
    if (!caps.sync2026 || body.length === 0) return body;
    return concatBytes([SYNC_BEGIN, body, SYNC_END]);
  };

  let renderScheduled = false;
  let renderTimer: number | undefined;
  let lastRender = 0;

  const renderNow = (): void => {
    try {
      next.clear();
      const lines: readonly StyledLine[] = program.view(model);
      const maxRow = Math.min(lines.length, next.h);
      for (let r = 0; r < maxRow; r++) {
        const spans = lines[r]?.spans;
        if (spans && spans.length > 0) next.writeLine(r, 0, spans);
      }
      const body = firstRender ? next.renderFull(caps) : prev.diff(next, caps);
      firstRender = false;
      writeSerial(wrapSync(body));
      // swap: the just-rendered `next` becomes `prev` (what's on screen); the
      // old `prev` is reused as the `next` scratch (cleared next tick).
      const tmp = prev;
      prev = next;
      next = tmp;
    } catch (err) {
      // A render fault must not kill the loop either; the next tick retries.
      console.error("@niuma/tuikit loop: render error:", err);
    }
  };

  /** Trailing-edge ~30fps throttle: coalesce rapid updates into one render. */
  const requestRender = (): void => {
    if (renderScheduled || quit) return;
    renderScheduled = true;
    const delay = Math.max(0, FRAME_MS - (Date.now() - lastRender));
    renderTimer = setTimeout(() => {
      renderTimer = undefined;
      renderScheduled = false;
      if (quit) return;
      renderNow();
      lastRender = Date.now();
    }, delay);
  };

  /**
   * Fire a batch of cmds. Each cmd's resolved msg is re-queued; a rejection is
   * caught and surfaced as `ErrorMsg` (choice: re-queue rather than log+drop
   * so the app's `update` is the single place that decides how to handle cmd
   * failures, including ignoring them). The loop never dies from a cmd fault.
   */
  const launch = (cmds: readonly Cmd<Msg>[]): void => {
    for (const c of cmds) {
      Promise.resolve()
        .then(() => c.run())
        .then((m) => {
          if (m !== undefined && m !== null) queue.push(m);
        })
        .catch((error) => {
          queue.push({ type: "tuikit:error", error } as unknown as Msg);
        });
    }
  };

  // -- init ---------------------------------------------------------------
  const [initModel, ...initCmds] = program.init();
  model = initModel;
  launch(initCmds);

  // -- subscriptions (once, for the run lifetime) -------------------------
  const unsubs: Array<() => void> = [];
  if (program.subscriptions) {
    for (const s of program.subscriptions(model)) {
      try {
        unsubs.push(s.subscribe((m) => queue.push(m)));
      } catch (err) {
        console.error("@niuma/tuikit loop: subscription error:", err);
      }
    }
  }

  // -- input pump: decoded stdin events -> KeyMsg -------------------------
  const inputPump = (async (): Promise<void> => {
    try {
      for await (const ev of terminal.events) {
        queue.push(
          { type: "tuikit:key", event: ev as InputEvent } as unknown as Msg,
        );
        if (quit) break;
      }
    } catch {
      // terminal closed under us — end of stream.
    }
  })();

  // -- resize: keep Frames in sync + force a full repaint + tell the app --
  const offResize = terminal.onResize((size) => {
    // Native frames reject 0 dimensions (a 0x0 resize would throw and, worse,
    // desync prev from next if only one succeeded). Skip the native resize
    // for degenerate geometry; the app still hears about it.
    if (size.cols > 0 && size.rows > 0) {
      try {
        prev.resize(size.cols, size.rows);
        next.resize(size.cols, size.rows);
      } catch {
        /* ignore geometry faults */
      }
      firstRender = true; // geometry changed -> diff is invalid, full-paint
    }
    queue.push({ type: "tuikit:resize", size } as unknown as Msg);
  });

  // -- main loop: batch -> update -> (coalesced) render -------------------
  requestRender(); // first paint, even before any input/tick arrives

  while (!quit) {
    await queue.wait();
    if (quit) break;
    const batch = queue.drain();
    for (const msg of batch) {
      const [nextModel, ...cmds] = program.update(model, msg);
      model = nextModel;
      launch(cmds);
      if (program.shouldQuit?.(model, msg)) {
        quit = true;
        break;
      }
    }
    requestRender();
  }

  // -- cleanup ------------------------------------------------------------
  // Stop new renders, drop subscriptions + resize listener, render the FINAL
  // frame (the batch that set quit is not rendered yet when quit fires mid-
  // tick — the coalesced timer is dropped), flush it, then dispose the
  // terminal (which closes the input stream and ends the pump). Finally free
  // both Frames.
  quit = true;
  queue.close();
  // Drop a still-pending coalesced render timer so it cannot fire after
  // teardown (and so the runtime does not leak it).
  if (renderTimer !== undefined) {
    clearTimeout(renderTimer);
    renderTimer = undefined;
    renderScheduled = false;
  }
  for (const u of unsubs) {
    try {
      u();
    } catch {
      /* best-effort */
    }
  }
  offResize();
  // Final frame: force a FULL repaint rather than a diff. Nothing will diff
  // against this frame afterwards, and a self-contained last write makes the
  // terminal's final state deterministic (a diff would only carry the cells
  // that changed since the last coalesced render).
  firstRender = true;
  renderNow(); // final frame: terminal state on screen matches the last model
  await writeChain; // flush pending render bytes before tearing down the screen

  terminal.dispose(); // closes events -> the for-await ends -> pump resolves

  // Bound the pump drain so a misbehaving stream can't hang shutdown. The
  // timer handle is cleared as soon as either side settles (no timer leak).
  let drainTimer: number | undefined;
  await Promise.race([
    inputPump,
    new Promise<void>((resolve) => {
      drainTimer = setTimeout(() => resolve(), 250);
    }),
  ]);
  if (drainTimer !== undefined) clearTimeout(drainTimer);

  try {
    prev.dispose();
  } catch {
    /* best-effort */
  }
  try {
    next.dispose();
  } catch {
    /* best-effort */
  }
};
