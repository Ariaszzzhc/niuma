// ===========================================================================
// @niuma/tuikit — terminal IO (pure TS; IO stays OUT of Rust)
// ---------------------------------------------------------------------------
// Owns everything syscalls / async:
//   - raw mode via Deno.stdin.setRaw
//   - console size via Deno.consoleSize + SIGWINCH listener -> onResize
//   - alternate screen enter/leave (ESC[?1049h/l)
//   - hide/show cursor (ESC[?25l/h)
//   - bracketed paste on/off (ESC[?2004h/l)
//   - kitty keyboard push/pop (ESC[>1u / ESC[<u)
//   - CSI 2026 beginSync/endSync byte constants (the loop composes them)
//   - capability detection (COLORTERM, TERM_PROGRAM incl. Apple_Terminal,
//     NO_COLOR, TERM contains kitty / 256color, Windows WT_SESSION /
//     ConEmuANSI truecolor fallback)
//   - Windows console setup via FFI (UTF-8 code page + VT processing,
//     restored on dispose)
//   - a single stdout writer
//   - the stdin byte stream exposed as decoded InputEvent[] via KeyParser
//
// dispose() is idempotent and restores EVERYTHING it changed, in reverse
// order. Stateful interop justifies the class.
// ===========================================================================

import type { InputEvent, TerminalCaps } from "./binding_contract.ts";
import { terminalPlatformSetup, terminalPlatformTeardown } from "./ffi.ts";
import { KeyParser } from "./keys.ts";

// ---------------------------------------------------------------------------
// Escape sequences (all opaque byte literals)
// ---------------------------------------------------------------------------

const ESC = 0x1b;
const CSI = [ESC, 0x5b]; // ESC [
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Alternate screen. */
const ENTER_ALT = enc("\x1b[?1049h");
const LEAVE_ALT = enc("\x1b[?1049l");
/** Cursor visibility. */
const HIDE_CURSOR = enc("\x1b[?25l");
const SHOW_CURSOR = enc("\x1b[?25h");
/** Bracketed paste. */
const PASTE_ON = enc("\x1b[?2004h");
const PASTE_OFF = enc("\x1b[?2004l");
/** SGR mouse reporting: button events (1002) + SGR encoding (1006). We use
 * 1002 (not 1003 any-motion) so the stream only carries presses + wheel
 * ticks, not hover noise. */
const MOUSE_ON = enc("\x1b[?1002h\x1b[?1006h");
const MOUSE_OFF = enc("\x1b[?1006l\x1b[?1002l");
/** Kitty keyboard protocol: push flags (disambiguate=bit1) / pop one level. */
const KITTY_PUSH = enc("\x1b[>1u");
const KITTY_POP = enc("\x1b[<u");

/** CSI 2026 synchronized-output markers (the loop wraps each write with these). */
export const SYNC_BEGIN: Uint8Array = enc("\x1b[?2026h");
export const SYNC_END: Uint8Array = enc("\x1b[?2026l");

void CSI;

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------

const envOr = (key: string): string => {
  try {
    return Deno.env.get(key) ?? "";
  } catch {
    return "";
  }
};

/**
 * Detect terminal capabilities from the environment. Heuristics (no IO):
 *   - NO_COLOR set             -> truecolor AND color256 forced off
 *   - TERM=dumb                -> truecolor AND color256 forced off
 *   - COLORTERM=truecolor/24bit-> truecolor
 *   - Windows Terminal / ConEmu-> truecolor (WT_SESSION set / ConEmuANSI=ON;
 *                                 they set neither TERM nor COLORTERM)
 *   - any Windows console      -> color256 (win10+ consoles support it)
 *   - TERM *256color*          -> color256 (truecolor implies 256)
 *   - kitty keyboard           -> TERM/TERM_PROGRAM matches kitty|wezterm|ghostty
 *   - bracketed paste          -> assumed unless TERM=dumb
 *   - sync 2026                -> known modern terminals (kitty/wezterm/
 *                                 ghostty/iterm/alacritty/foot/xterm)
 */
export const detectCaps = (): TerminalCaps => {
  const term = envOr("TERM");
  const termProgram = envOr("TERM_PROGRAM");
  const colorterm = envOr("COLORTERM").toLowerCase();
  const noColor = envOr("NO_COLOR").length > 0;
  const blob = `${term} ${termProgram}`.toLowerCase();

  const isDumb = term === "dumb";
  const isWindows = Deno.build.os === "windows";
  // Windows Terminal / ConEmu are truecolor but export no TERM/COLORTERM
  // (mirrors Node.js getColorDepth).
  const wtLike = isWindows &&
    (envOr("WT_SESSION") !== "" || envOr("ConEmuANSI") === "ON");
  const truecolor = !noColor && !isDumb &&
    (colorterm === "truecolor" || colorterm === "24bit" || wtLike);
  const color256 = !noColor && !isDumb &&
    (truecolor || isWindows || term.includes("256color"));

  const kittyKeyboard = /\bkitty\b/.test(blob) || /wezterm/.test(blob) ||
    /ghostty/.test(blob);

  const bracketedPaste = !isDumb;

  const sync2026 = !isDumb && (
    /\bkitty\b/.test(blob) ||
    /wezterm/.test(blob) ||
    /ghostty/.test(blob) ||
    /iterm/.test(blob) ||
    /alacritty/.test(blob) ||
    /\bfoot\b/.test(blob) ||
    /\bxterm\b/.test(blob)
  );

  return { truecolor, color256, kittyKeyboard, bracketedPaste, sync2026 };
};

// ---------------------------------------------------------------------------
// Minimal async queue (single consumer) for the input event stream
// ---------------------------------------------------------------------------

class AsyncQueue<T> implements AsyncIterable<T> {
  #bufs: T[] = [];
  #waiters: Array<(r: IteratorResult<T>) => void> = [];
  #closed = false;

  push(v: T): void {
    if (this.#closed) return;
    const w = this.#waiters.shift();
    if (w) w({ value: v, done: false });
    else this.#bufs.push(v);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const w of this.#waiters) w({ value: undefined as T, done: true });
    this.#waiters = [];
  }

  next(): Promise<IteratorResult<T>> {
    if (this.#bufs.length > 0) {
      return Promise.resolve({ value: this.#bufs.shift() as T, done: false });
    }
    if (this.#closed) {
      return Promise.resolve({ value: undefined as T, done: true });
    }
    return new Promise((res) => this.#waiters.push(res));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

/** Read the current terminal size, defaulting to 80x24 when not a TTY. */
const readSize = (): TerminalSize => {
  try {
    const s = Deno.consoleSize();
    if (s && s.columns > 0 && s.rows > 0) {
      return { cols: s.columns, rows: s.rows };
    }
  } catch {
    /* not a TTY */
  }
  return { cols: 80, rows: 24 };
};

/**
 * Raw-mode terminal session owning the alt screen, paste mode, kitty
 * keyboard negotiation, and the decoded input stream. Always call
 * `dispose()` (idempotent) to restore the original terminal state.
 */
export class Terminal {
  #caps: TerminalCaps;
  #size: TerminalSize;
  #parser: KeyParser;
  #queue: AsyncQueue<InputEvent>;
  #resizeListeners: Array<(size: TerminalSize) => void> = [];
  #reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  #sigwinchHandler: (() => void) | null = null;
  #disposed = false;
  /** Tracks what we enabled so dispose restores exactly that. */
  #pushedKitty = false;
  #enabledPaste = false;
  #enabledMouse = false;
  #enteredAlt = false;
  #rawSet = false;

  private constructor() {
    this.#caps = detectCaps();
    this.#size = readSize();
    this.#parser = KeyParser.create();
    this.#queue = new AsyncQueue<InputEvent>();
  }

  /**
   * Enter raw mode + alternate screen, detect caps, enable bracketed paste,
   * push kitty keyboard flags when supported, and start the stdin pump.
   * Registers a SIGWINCH listener.
   */
  static open(): Terminal {
    const term = new Terminal();
    term.#enter();
    term.#startPump();
    term.#registerSigwinch();
    return term;
  }

  get caps(): TerminalCaps {
    return this.#caps;
  }

  get size(): TerminalSize {
    return this.#size;
  }

  /** Resolves on terminal resize with the new size. Returns an unsubscribe. */
  readonly onResize = (cb: (size: TerminalSize) => void): () => void => {
    this.#resizeListeners.push(cb);
    return () => {
      const i = this.#resizeListeners.indexOf(cb);
      if (i >= 0) this.#resizeListeners.splice(i, 1);
    };
  };

  /** Async iterable of decoded input events (keyboard / paste). */
  get events(): AsyncIterable<InputEvent> {
    return this.#queue;
  }

  /** Write bytes to stdout (single serialized writer). */
  readonly write = async (bytes: Uint8Array): Promise<void> => {
    if (bytes.length === 0) return;
    await Deno.stdout.write(bytes);
  };

  // -- setup / teardown internals -------------------------------------------

  #enter(): void {
    // Windows console: UTF-8 code page + VT processing (no-op elsewhere;
    // failure is advisory — worst case we render as before).
    terminalPlatformSetup();
    // raw mode
    Deno.stdin.setRaw(true);
    this.#rawSet = true;
    // alt screen + cursor
    Deno.stdout.writeSync(ENTER_ALT);
    this.#enteredAlt = true;
    Deno.stdout.writeSync(HIDE_CURSOR);
    // bracketed paste
    if (this.#caps.bracketedPaste) {
      Deno.stdout.writeSync(PASTE_ON);
      this.#enabledPaste = true;
    }
    // SGR mouse (button + wheel reports; no any-motion)
    Deno.stdout.writeSync(MOUSE_ON);
    this.#enabledMouse = true;
    // kitty keyboard
    if (this.#caps.kittyKeyboard) {
      Deno.stdout.writeSync(KITTY_PUSH);
      this.#pushedKitty = true;
    }
  }

  #startPump(): void {
    this.#reader = Deno.stdin.readable.getReader();
    void this.#pump();
  }

  /** Read stdin chunks forever, feed the parser, push decoded events. */
  async #pump(): Promise<void> {
    if (!this.#reader) return;
    try {
      while (!this.#disposed) {
        const { done, value } = await this.#reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        const events = this.#parser.feed(value);
        for (const ev of events) this.#queue.push(ev);
      }
    } catch {
      // reader cancelled or stdin closed — end of stream.
    } finally {
      this.#queue.close();
    }
  }

  #registerSigwinch(): void {
    if (Deno.build.os === "windows") return; // no SIGWINCH on Windows
    const handler = (): void => {
      const next = readSize();
      this.#size = next;
      for (const cb of this.#resizeListeners) {
        try {
          cb(next);
        } catch {
          /* a listener must not take down the resize path */
        }
      }
    };
    this.#sigwinchHandler = handler;
    try {
      Deno.addSignalListener("SIGWINCH", handler);
    } catch {
      this.#sigwinchHandler = null; // signal unavailable — resize won't fire
    }
  }

  /**
   * Restore the terminal: stop pump, pop kitty flags, paste off, show cursor,
   * leave alt-screen, cooked mode, drop SIGWINCH. Idempotent.
   */
  readonly dispose = (): void => {
    if (this.#disposed) return;
    this.#disposed = true;

    // stop the pump first so we stop mutating the queue.
    if (this.#reader) {
      try {
        void this.#reader.cancel();
      } catch {
        /* ignore */
      }
    }
    this.#queue.close();

    // restore escape state (order matters: alt-screen leave LAST)
    if (this.#pushedKitty) Deno.stdout.writeSync(KITTY_POP);
    if (this.#enabledMouse) Deno.stdout.writeSync(MOUSE_OFF);
    if (this.#enabledPaste) Deno.stdout.writeSync(PASTE_OFF);
    Deno.stdout.writeSync(SHOW_CURSOR);
    if (this.#enteredAlt) Deno.stdout.writeSync(LEAVE_ALT);

    // cooked mode
    if (this.#rawSet) {
      try {
        Deno.stdin.setRaw(false);
      } catch {
        /* ignore */
      }
    }

    // drop SIGWINCH
    if (this.#sigwinchHandler) {
      try {
        Deno.removeSignalListener("SIGWINCH", this.#sigwinchHandler);
      } catch {
        /* ignore */
      }
      this.#sigwinchHandler = null;
    }

    // free parser
    this.#parser.dispose();

    // restore Windows console code page / VT mode (no-op elsewhere)
    terminalPlatformTeardown();
  };
}
