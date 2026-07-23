// ===========================================================================
// @niuma/tuikit — native Frame handle wrapper
// ---------------------------------------------------------------------------
// A Frame is an opaque `w x h` cell grid owned by Rust (created by
// `tuikit_frame_create`, freed by `tuikit_frame_free`). The TEA loop double-
// buffers two Frames: each tick writes the new view into `next`, diffs
// `prev` -> `next` (or render_full on first paint), then swaps.
//
// `dispose()` frees the handle exactly once. A `FinalizationRegistry` is the
// safety net for the case where a caller forgets to dispose — deterministic
// disposal remains the contract.
// ===========================================================================

import { type StyledSpan, type TerminalCaps } from "./binding-contract.ts";
import { encodeSpans, packCaps, acquireBuffer, releaseBuffer, withRetry } from "./buffer.ts";
import { checkHandle, checkI64, symbols, TuikitError } from "./ffi.ts";

/** Free-handle callback shared by every Frame's FinalizationRegistry. */
const frameRegistry = new FinalizationRegistry((handle: Deno.PointerValue) => {
  try {
    symbols().tuikit_frame_free(handle);
  } catch {
    // Library already unloaded (process teardown) — nothing to free.
  }
});

/**
 * A native cell grid. Construct via {@link Frame.create}; always `dispose()`
 * when done. The handle is single-threaded (the TS loop is single-threaded).
 */
export class Frame {
  #handle: Deno.PointerValue;
  #w: number;
  #h: number;
  #disposed = false;

  private constructor(handle: Deno.PointerValue, w: number, h: number) {
    this.#handle = handle;
    this.#w = w;
    this.#h = h;
    frameRegistry.register(this, handle, this);
  }

  /** Create a `w x h` frame cleared to default-styled blanks. */
  static create(w: number, h: number): Frame {
    const handle = checkHandle("tuikit_frame_create", symbols().tuikit_frame_create(w, h));
    return new Frame(handle, w, h);
  }

  get w(): number {
    return this.#w;
  }
  get h(): number {
    return this.#h;
  }

  /** Raw handle — exported for loop.ts double-buffering (diff needs both). */
  get handle(): Deno.PointerValue {
    return this.#handle;
  }

  /** Resize to `w x `h`, preserving the overlapping top-left region. */
  resize(w: number, h: number): void {
    this.#ensure();
    const r = symbols().tuikit_frame_resize(this.#handle, w, h);
    if (checkI64("tuikit_frame_resize", r) !== 0) {
      throw new TuikitError("tuikit_frame_resize", "resize returned non-zero");
    }
    this.#w = w;
    this.#h = h;
  }

  /** Clear every cell to a default-styled blank. */
  clear(): void {
    this.#ensure();
    const r = symbols().tuikit_frame_clear(this.#handle);
    if (checkI64("tuikit_frame_clear", r) !== 0) {
      throw new TuikitError("tuikit_frame_clear", "clear returned non-zero");
    }
  }

  /**
   * Write spans at (`row`, `col`), clipped at the right edge mid-cluster
   * (a straddling cluster is dropped, never half-drawn). Rows are NOT
   * scrolled; the caller owns layout.
   */
  writeLine(row: number, col: number, spans: readonly StyledSpan[]): void {
    this.#ensure();
    const { ptr, count, backing } = encodeSpans(spans);
    // `backing` is referenced here for the whole call — keep it until the
    // native fn returns, then it is eligible for GC.
    const r = symbols().tuikit_frame_write_line(
      this.#handle,
      row,
      col,
      count === 0 ? null : ptr,
      count,
    );
    void backing;
    if (checkI64("tuikit_frame_write_line", r) !== 0) {
      throw new TuikitError("tuikit_frame_write_line", "write_line returned non-zero");
    }
  }

  /**
   * Diff this frame (as `prev`) against `next`; returns ANSI bytes turning
   * the screen from `prev` into `next`. `caps` selects the colour depth for
   * emitted SGR (truecolor / 256 / 16) — the same word {@link renderFull}
   * uses — so the diff path quantizes colours consistently with the first
   * paint on non-truecolor terminals.
   */
  diff(next: Frame, caps: TerminalCaps): Uint8Array {
    this.#ensure();
    const capsWord = packCaps(caps);
    const buf = acquireBuffer(1024);
    try {
      const lib = symbols();
      const call = (outPtr: Deno.PointerValue, cap: number) =>
        lib.tuikit_frame_diff(this.#handle, next.#handle, capsWord, outPtr, cap);
      const total = withRetry(buf, call);
      return buf.view.subarray(0, total).slice();
    } finally {
      releaseBuffer(buf);
    }
  }

  /** Full-paint ANSI bytes for this frame (first paint / redraw). */
  renderFull(caps: TerminalCaps): Uint8Array {
    this.#ensure();
    const capsWord = packCaps(caps);
    const buf = acquireBuffer(4096);
    try {
      const lib = symbols();
      const call = (outPtr: Deno.PointerValue, cap: number) =>
        lib.tuikit_frame_render_full(this.#handle, capsWord, outPtr, cap);
      const total = withRetry(buf, call);
      return buf.view.subarray(0, total).slice();
    } finally {
      releaseBuffer(buf);
    }
  }

  /** Free the native handle. Idempotent. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    frameRegistry.unregister(this);
    try {
      symbols().tuikit_frame_free(this.#handle);
    } catch {
      // Library unloaded — nothing to free.
    }
  }

  #ensure(): void {
    if (this.#disposed) {
      throw new TuikitError("frame", "use of disposed Frame");
    }
  }
}
