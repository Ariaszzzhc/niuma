// @niuma/tuikit — FFI binding contract (TypeScript side).
//
// This file is the TS mirror of `packages/tuikit/native/src/abi.rs`. It
// defines, WITHOUT implementations:
//   1. the exact `Deno.dlopen` symbol map (names must match abi.rs);
//   2. TypeScript views of every fixed-layout binary record, with byte
//      offsets (decoded via DataView, little-endian);
//   3. the public currency types (StyledSpan / StyledLine / Style / Color /
//      KeyEvent / PasteEvent / TerminalCaps);
//   4. the API shape each wrapper module under `src/` will export
//      (ffi/buffer/frame/keys/style/width/terminal/loop/mod).
//
// Contract summary (see abi.rs module docs for the authoritative text):
//   - caller (TS) allocates every output buffer; Rust writes
//     min(total, cap) and returns the TOTAL bytes needed as i64; TS grows
//     and retries when ret > cap ("retry dance");
//   - opaque handles (*mut Frame / *mut KeyParser) come from paired
//     create/free; wrappers dispose deterministically and back that with
//     FinalizationRegistry;
//   - every native fn returns -1 (or null handle) on panic — never throws
//     across the boundary;
//   - no JSON, no serde: binary records only.
//
// Deno ffi types used below: "pointer" (u64 host pointer), "u8", "u16",
// "u32", "u64", "i64". Deno.dlopen returns i64 results as bigint.

// ===========================================================================
// 1. Deno.dlopen symbol map
// ===========================================================================

/** Exact symbol table passed to `Deno.dlopen(path, SYMBOLS)`. Symbol names
 * and parameter order MUST match `#[no_mangle] extern "C"` fns in abi.rs. */
export const SYMBOLS = {
  // -- width ---------------------------------------------------------------
  /** (ptr, len) -> width in cells (i64; -1 on panic). */
  tuikit_width: {
    parameters: ["pointer", "u32"],
    result: "i64",
  },
  /** (ptr, len, max_width, ellipsis, out, cap) -> total bytes needed. */
  tuikit_truncate: {
    parameters: ["pointer", "u32", "u32", "u8", "pointer", "u32"],
    result: "i64",
  },

  // -- cellbuf -------------------------------------------------------------
  /** (w, h) -> opaque Frame* (null on panic/invalid). */
  tuikit_frame_create: {
    parameters: ["u32", "u32"],
    result: "pointer",
  },
  /** (handle) -> void; null is a no-op. */
  tuikit_frame_free: {
    parameters: ["pointer"],
    result: "void",
  },
  /** (handle, w, h) -> 0 ok / -1 fault. */
  tuikit_frame_resize: {
    parameters: ["pointer", "u32", "u32"],
    result: "i64",
  },
  /** (handle) -> 0 ok / -1 fault. */
  tuikit_frame_clear: {
    parameters: ["pointer"],
    result: "i64",
  },
  /** (handle, row, col, spans_ptr, span_count) -> 0 ok / -1 fault. */
  tuikit_frame_write_line: {
    parameters: ["pointer", "u32", "u32", "pointer", "u32"],
    result: "i64",
  },

  // -- diff ----------------------------------------------------------------
  /** (prev, next, caps, out, cap) -> total ANSI bytes needed. `caps`
   * selects the colour depth for emitted SGR (truecolor / 256 / 16), keeping
   * the diff path consistent with tuikit_frame_render_full. */
  tuikit_frame_diff: {
    parameters: ["pointer", "pointer", "u32", "pointer", "u32"],
    result: "i64",
  },
  /** (frame, caps, out, cap) -> total ANSI bytes needed. */
  tuikit_frame_render_full: {
    parameters: ["pointer", "u32", "pointer", "u32"],
    result: "i64",
  },

  // -- keys ----------------------------------------------------------------
  /** () -> opaque KeyParser* (null on panic). */
  tuikit_keys_create: {
    parameters: [],
    result: "pointer",
  },
  /** (handle) -> void. */
  tuikit_keys_free: {
    parameters: ["pointer"],
    result: "void",
  },
  /** (handle, bytes, len, out, cap) -> total bytes needed; if > cap the
   * input was NOT consumed and must be re-fed after growing `out`. */
  tuikit_keys_feed: {
    parameters: ["pointer", "pointer", "u32", "pointer", "u32"],
    result: "i64",
  },

  // -- sgr -----------------------------------------------------------------
  /** (fg, bg, attrs, caps, out, cap) -> total SGR bytes needed. */
  tuikit_sgr_style: {
    parameters: ["u32", "u32", "u16", "u32", "pointer", "u32"],
    result: "i64",
  },
  /** (r, g, b) -> xterm 256 palette index (16..255). */
  tuikit_rgb_to_256: {
    parameters: ["u8", "u8", "u8"],
    result: "i64",
  },
  /** (r, g, b) -> named-16 palette index (0..15). */
  tuikit_rgb_to_16: {
    parameters: ["u8", "u8", "u8"],
    result: "i64",
  },
  /** (from_rgb, to_rgb, text, len, bg, caps, out, cap) -> total bytes
   * needed (cluster_count * 16). Both colors MUST be RGB-tagged words. */
  tuikit_gradient: {
    parameters: ["u32", "u32", "pointer", "u32", "u32", "u32", "pointer", "u32"],
    result: "i64",
  },
} as const satisfies Deno.ForeignLibraryInterface;

/** The dlopen'd library handle type, derived from SYMBOLS. */
export type TuikitLib = Deno.DynamicLibrary<typeof SYMBOLS>;

// ===========================================================================
// 2. Binary record views (DataView decode, all little-endian)
// ===========================================================================

// -- SpanRec: input record for tuikit_frame_write_line — 24 bytes ----------
//
//   offset  size  field
//   0       8     text_ptr  u64   pointer into a pinned UTF-8 buffer
//   8       4     text_len  u32   BYTE length (not width, not chars)
//   12      4     fg        u32   tagged color word
//   16      4     bg        u32   tagged color word
//   20      2     attrs     u16   ATTR_* bitflags
//   22      2     _pad            must be 0
export const SPAN_REC_SIZE = 24;
export const SPAN_REC_OFF = {
  textPtr: 0,
  textLen: 8,
  fg: 12,
  bg: 16,
  attrs: 20,
} as const;

// -- KeyEventRec: fixed 16-byte event record from tuikit_keys_feed ---------
//
//   offset  size  field
//   0       1     kind        u8   KEY_KIND_*
//   1       1     event_type  u8   KEY_EVENT_* (0 = legacy/non-kitty)
//   2       2     key_code    u16  KEY_CODE_* (0 = text in payload)
//   4       1     mods        u8   MOD_* bitflags (kitty mask-1 applied)
//   5       1     _pad
//   6       2     text_len    u16  payload byte length (0 = none)
//   8       4     text_ofs    u32  payload offset FROM BUFFER START
//   12      4     _reserved
//
// Whole out-buffer layout from tuikit_keys_feed:
//   [0..4)                u32 event_count (LE)
//   [4 .. 4+16N)          N * KeyEventRec
//   [4+16N .. total)      payload arena (text / paste bytes)
export const KEY_EVENT_REC_SIZE = 16;
export const KEY_EVENT_REC_OFF = {
  kind: 0,
  eventType: 1,
  keyCode: 2,
  mods: 4,
  textLen: 6,
  textOfs: 8,
} as const;
/** Offset of the u32 event-count header at the start of the out buffer. */
export const KEYS_OUT_HEADER_SIZE = 4;

// -- GradSpanRec: gradient output record — 16 bytes -------------------------
//
//   offset  size  field
//   0       4     byte_ofs  u32  cluster start within the ORIGINAL text
//   4       4     byte_len  u32  cluster byte length
//   8       4     fg        u32  interpolated color (tag per caps)
//   12      4     bg        u32  input bg word, verbatim
export const GRAD_SPAN_REC_SIZE = 16;
export const GRAD_SPAN_REC_OFF = {
  byteOfs: 0,
  byteLen: 4,
  fg: 8,
  bg: 12,
} as const;

// ===========================================================================
// 3. Constants (mirror abi.rs)
// ===========================================================================

// -- Color tags (top 2 bits of the u32 word) --------------------------------
export const COLOR_TAG = {
  default: 0,
  named16: 1,
  indexed256: 2,
  rgb: 3,
} as const;
export type ColorTag = (typeof COLOR_TAG)[keyof typeof COLOR_TAG];

// -- Attr bitflags (u16) -----------------------------------------------------
export const ATTR = {
  bold: 1 << 0,
  dim: 1 << 1,
  italic: 1 << 2,
  underline: 1 << 3,
  strikethrough: 1 << 4,
  reverse: 1 << 5,
} as const;

// -- Terminal capability bitflags (u32 caps) ---------------------------------
export const CAP = {
  color256: 1 << 0,
  truecolor: 1 << 1,
  kittyKeyboard: 1 << 3,
  bracketedPaste: 1 << 4,
  sync2026: 1 << 5,
} as const;

// -- Key event kinds ---------------------------------------------------------
export const KEY_KIND = {
  key: 0,
  paste: 1,
  esc: 2,
} as const;
export type KeyKind = (typeof KEY_KIND)[keyof typeof KEY_KIND];

// -- Key event types (Kitty press/repeat/release; 0 = legacy) ----------------
// KEY_EVENT_TYPE mirrors the ABI *byte* values (0..3) used in the binary
// KeyEventRec; the decoded TS event carries the string KeyEventType below.
export const KEY_EVENT_TYPE = {
  legacy: 0,
  press: 1,
  repeat: 2,
  release: 3,
} as const;
/**
 * Decoded event type carried by `KeyEvent.eventType`. ABI bytes 0 (legacy)
 * and 1 (Kitty press) both surface as "press"; only Kitty keyboards produce
 * "repeat"/"release". (This is the TS-side decoded string union, NOT the
 * numeric KEY_EVENT_TYPE byte values above.)
 */
export type KeyEventType = "press" | "repeat" | "release";

// -- Modifier bits (decoded; kitty mask-1 already applied) -------------------
export const MOD = {
  shift: 1 << 0,
  alt: 1 << 1,
  ctrl: 1 << 2,
  super: 1 << 3,
} as const;

// -- Named key codes (0 = printable text in payload) --------------------------
export const KEY_CODE = {
  text: 0,
  enter: 1,
  tab: 2,
  backspace: 3,
  up: 4,
  down: 5,
  right: 6,
  left: 7,
  home: 8,
  end: 9,
  pageUp: 10,
  pageDown: 11,
  insert: 12,
  delete: 13,
  f1: 14,
  f2: 15,
  f3: 16,
  f4: 17,
  f5: 18,
  f6: 19,
  f7: 20,
  f8: 21,
  f9: 22,
  f10: 23,
  f11: 24,
  f12: 25,
} as const;
export type KeyCode = (typeof KEY_CODE)[keyof typeof KEY_CODE];

// ===========================================================================
// 4. Currency types (TS-side)
// ===========================================================================

/** A color as authored in TS. Serialized to the tagged u32 word when
 * crossing the FFI boundary:
 *   - "default"                 -> tag 0
 *   - { named16: idx }          -> tag 1, idx 0..15
 *   - { indexed256: idx }       -> tag 2, idx 0..255
 *   - { rgb: [r, g, b] }        -> tag 3, r<<16|g<<8|b
 */
export type Color =
  | "default"
  | { readonly named16: number }
  | { readonly indexed256: number }
  | { readonly rgb: readonly [number, number, number] };

/** Text style. Optional fields default to "unset" (no SGR emitted for
 * them); the packed u16 ATTR word only sets bits for true fields. */
export interface Style {
  readonly fg?: Color;
  readonly bg?: Color;
  readonly bold?: boolean;
  readonly dim?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strikethrough?: boolean;
  readonly reverse?: boolean;
}

/** The currency of the render pipeline: a run of text with one style. */
export interface StyledSpan {
  readonly text: string;
  readonly style: Style;
}

/** One terminal row of content: concatenated spans. The loop's View
 * produces StyledLine[]; frame.writeLine serializes spans into SpanRec
 * records. */
export interface StyledLine {
  readonly spans: readonly StyledSpan[];
}

/** Terminal capability snapshot detected by terminal.ts and passed into
 * native fns as the `caps` bitflag word (CAP.*). Also drives TS-side
 * decisions (kitty negotiation, CSI 2026 wrapping). */
export interface TerminalCaps {
  readonly color256: boolean;
  readonly truecolor: boolean;
  readonly kittyKeyboard: boolean;
  readonly bracketedPaste: boolean;
  readonly sync2026: boolean;
}

// -- Key events ---------------------------------------------------------------

/** Modifier state carried by a key event. */
export interface KeyMods {
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
  readonly super: boolean;
}

/** Named (non-text) keys, decoded from KEY_CODE. */
export type NamedKey =
  | "enter"
  | "tab"
  | "backspace"
  | "up"
  | "down"
  | "right"
  | "left"
  | "home"
  | "end"
  | "pageUp"
  | "pageDown"
  | "insert"
  | "delete"
  | "f1"
  | "f2"
  | "f3"
  | "f4"
  | "f5"
  | "f6"
  | "f7"
  | "f8"
  | "f9"
  | "f10"
  | "f11"
  | "f12";

/** Decoded keyboard event.
 *  - `kind: "text"` — printable input; `text` is the decoded string
 *    (may be a multi-codepoint grapheme; alt+char arrives here with
 *    `mods.alt` set).
 *  - `kind: "key"` — a named key.
 *  - `kind: "esc"` — bare Escape.
 *  `eventType` is "press" for all legacy input; "repeat"/"release" only
 *  appear under the Kitty keyboard protocol. */
export type KeyEvent =
  | {
    readonly kind: "text";
    readonly text: string;
    readonly mods: KeyMods;
    readonly eventType: KeyEventType;
  }
  | {
    readonly kind: "key";
    readonly key: NamedKey;
    readonly mods: KeyMods;
    readonly eventType: KeyEventType;
  }
  | { readonly kind: "esc" };

/** Bracketed-paste event; `text` is the full pasted body. */
export interface PasteEvent {
  readonly kind: "paste";
  readonly text: string;
}

/** Anything keys.ts can hand to the app. */
export type InputEvent = KeyEvent | PasteEvent;

// ===========================================================================
// 5. Decode mapping: binary records -> TS types
// ===========================================================================

/** Declarative description of the KeyEventRec -> InputEvent mapping that
 * buffer.ts/keys.ts implement with DataView (all getters little-endian):
 *
 *  1. read u32 event_count at buffer offset 0;
 *  2. for i in 0..count, record base = KEYS_OUT_HEADER_SIZE + i*16:
 *       kind       = getUint8(base + 0)
 *       eventType  = getUint8(base + 1)
 *       keyCode    = getUint16(base + 2, LE)
 *       modsByte   = getUint8(base + 4)
 *       textLen    = getUint16(base + 6, LE)
 *       textOfs    = getUint32(base + 8, LE)
 *  3. mods = { shift: b&1, alt: b&2, ctrl: b&4, super: b&8 };
 *  4. payload = utf8decode(buf[textOfs .. textOfs+textLen]) when len>0;
 *  5. mapping:
 *       kind == KEY_KIND.paste                    -> PasteEvent
 *       kind == KEY_KIND.esc                      -> { kind: "esc" }
 *       kind == KEY_KIND.key && keyCode == text   -> KeyEvent text (payload)
 *       kind == KEY_KIND.key && keyCode in named  -> KeyEvent key
 *     eventType: 0/1 -> "press", 2 -> "repeat", 3 -> "release".
 */
export type KeyRecordDecode = never; // marker type; see doc above.

// ===========================================================================
// 6. Wrapper module API shapes (signatures only)
// ===========================================================================

// -- src/ffi.ts ---------------------------------------------------------------
// Owns Deno.dlopen, library path resolution per Deno.build.os
// (native/target/release/libniuma_tuikit.{dylib,so} on Unix, niuma_tuikit.dll
// on Windows), and a clear error
// ("run deno task build:native") when the artifact is missing.

/** Resolve the platform-specific library path relative to this package. */
export declare const libPath: () => string;

/** Open the native library (memoized). Throws with build instructions when
 * the artifact is missing. */
export declare const openLib: () => TuikitLib;

/** Guard: a native fn returned -1 (or null handle) -> throw TuikitError. */
export declare class TuikitError extends Error {
  readonly op: string;
}

// -- src/buffer.ts -------------------------------------------------------------
// Growable output-buffer pool + DataView encode/decode helpers. Buffers are
// allocated with Deno.UnsafePointer.of / new Uint8Array and pinned for the
// duration of a call.

/** A reusable output buffer that grows on demand for the retry dance. */
export interface OutBuffer {
  /** Current capacity in bytes. */
  readonly cap: number;
  /** Bytes view of the last successful call: buf.subarray(0, used). */
  readonly view: Uint8Array;
  /** Raw pointer for FFI calls. */
  readonly pointer: Deno.PointerValue;
}

/** Obtain a pooled buffer with at least `min` capacity. */
export declare const acquireBuffer: (min: number) => OutBuffer;
/** Return a buffer to the pool. */
export declare const releaseBuffer: (buf: OutBuffer) => void;
/**
 * The retry dance shared by every out-taking native call:
 *   let total = call(buf); while (total > buf.cap) { grow; total = call(buf); }
 * `call` receives (pointer, cap) and returns the native i64 as number.
 * Returns the final byte count; `acquireBuffer` result holds the bytes.
 */
export declare const withRetry: (
  buf: OutBuffer,
  call: (ptr: Deno.PointerValue, cap: number) => number,
) => number;
/** Serialize a StyledSpan list into pinned SpanRec bytes for
 * tuikit_frame_write_line. Returns the records pointer + record count +
 * the pinned backing (must stay alive for the call). */
export declare const encodeSpans: (
  spans: readonly StyledSpan[],
) => { readonly ptr: Deno.PointerValue; readonly count: number };
/** Decode the tuikit_keys_feed out buffer into InputEvent[] per the
 * mapping documented at KeyRecordDecode. */
export declare const decodeKeyEvents: (
  buf: Uint8Array,
  total: number,
) => InputEvent[];
/** Pack/unpack the tagged u32 color word. */
export declare const packColor: (c: Color | undefined) => number;
export declare const unpackColor: (word: number) => Color;
/** Pack a Style into (fgWord, bgWord, attrBits). */
export declare const packStyle: (
  s: Style,
) => { readonly fg: number; readonly bg: number; readonly attrs: number };
/** Pack TerminalCaps into the u32 caps word. */
export declare const packCaps: (c: TerminalCaps) => number;

// -- src/frame.ts ---------------------------------------------------------------
// Opaque Frame handle wrapper. Double-buffered by the loop: prev/next
// frames, swap after each diff.

/** A native cell grid. Dispose deterministically; FinalizationRegistry is
 * the safety net only. */
export declare class Frame {
  private constructor();
  static create(w: number, h: number): Frame;
  readonly w: number;
  readonly h: number;
  resize(w: number, h: number): void;
  clear(): void;
  /** Write spans at (row, col), clipped at the right edge mid-cluster
   * (cluster dropped, not half-drawn). */
  writeLine(row: number, col: number, spans: readonly StyledSpan[]): void;
  /** Diff this frame (as prev) against `next`; returns ANSI bytes. */
  diff(next: Frame, caps: TerminalCaps): Uint8Array;
  /** Full-paint ANSI bytes for this frame (first paint). */
  renderFull(caps: TerminalCaps): Uint8Array;
  dispose(): void;
}

// -- src/keys.ts ----------------------------------------------------------------
// Incremental parser wrapper fed by terminal.ts stdin reads.

export declare class KeyParser {
  private constructor();
  static create(): KeyParser;
  /** Feed raw stdin bytes; returns all events completed by this chunk
   * (partial sequences are held internally across calls). Handles the
   * not-consumed-on-overflow retry internally. */
  feed(bytes: Uint8Array): InputEvent[];
  dispose(): void;
}

// -- src/style.ts ---------------------------------------------------------------
// SGR generation and color helpers.

/** SGR bytes for a style, quantized to caps (starts with ESC[0m). */
export declare const styleToSgr: (
  style: Style,
  caps: TerminalCaps,
) => Uint8Array;
/** rgb -> xterm 256 index (cube + grayscale ramp, nearer wins). */
export declare const rgbTo256: (r: number, g: number, b: number) => number;
/** rgb -> nearest named-16 palette index. */
export declare const rgbTo16: (r: number, g: number, b: number) => number;
/** Quantize any Color to what caps supports (rgb may drop to 256/16). */
export declare const quantizeColor: (c: Color, caps: TerminalCaps) => Color;
/** One StyledSpan per grapheme cluster of `text`, fg interpolated
 * linearly from `from` to `to` (RGB), quantized per caps. */
export declare const gradient: (
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  text: string,
  style: Style,
  caps: TerminalCaps,
) => StyledSpan[];

// -- src/width.ts ---------------------------------------------------------------

/** Display width of a string in terminal cells (EAW + grapheme rules). */
export declare const stringWidth: (s: string) => number;
/** Truncate to `maxWidth` cells at cluster boundaries; optional "…". */
export declare const truncateToWidth: (
  s: string,
  maxWidth: number,
  ellipsis?: boolean,
) => string;

// -- src/terminal.ts ------------------------------------------------------------
// Raw mode, alt-screen, kitty keyboard negotiation, bracketed paste on/off,
// CSI 2026 support detection, SIGWINCH, capability detection, dispose
// safety net. Pure TS (syscall/IO lives here, not in Rust).

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

export declare class Terminal {
  private constructor();
  /** Enter raw mode + alternate screen, detect caps, enable bracketed
   * paste, push kitty keyboard flags when supported. Registers SIGWINCH. */
  static open(): Promise<Terminal>;
  readonly caps: TerminalCaps;
  readonly size: TerminalSize;
  /** Resolves on terminal resize (SIGWINCH) with the new size. */
  readonly onResize: (cb: (size: TerminalSize) => void) => () => void;
  /** Async iterable of decoded input events (feeds KeyParser). */
  readonly events: AsyncIterable<InputEvent>;
  /** Write bytes to stdout (single serialized writer). */
  write(bytes: Uint8Array): Promise<void>;
  /** Restore the terminal: pop kitty flags, paste off, leave alt-screen,
   * cooked mode. Idempotent; also registered via FinalizationRegistry and
   * process-exit hooks. */
  dispose(): void;
}

// -- src/loop.ts ----------------------------------------------------------------
// The TEA runtime. Owns the Frame double buffer and the CSI 2026 wrap:
// emitted output per tick is
//   ESC[?2026h   (when caps.sync2026)
//   <diff bytes from Frame.diff / Frame.renderFull>
//   ESC[?2026l
// written as ONE Terminal.write to minimize flicker. Rust never emits
// 2026 markers itself.

export interface Cmd<Msg> {
  readonly run: () => Promise<Msg | undefined>;
}

export interface Program<Model, Msg> {
  readonly init: () => readonly [Model, ...Cmd<Msg>[]];
  readonly update: (model: Model, msg: Msg) => readonly [Model, ...Cmd<Msg>[]];
  /** Produces the full screen as styled lines (rows 0..). */
  readonly view: (model: Model) => readonly StyledLine[];
}

/** Run a TEA program: input events + cmd results -> update -> view ->
 * frame.writeLine per row -> diff -> CSI-2026-wrapped write. Targets
 * 30fps with coalesced dirty ticks; first paint uses renderFull. */
export declare const run: <Model, Msg>(
  terminal: Terminal,
  program: Program<Model, Msg>,
) => Promise<void>;

// -- src/mod.ts -------------------------------------------------------------------
// Public surface of @niuma/tuikit: re-exports the currency types
// (StyledSpan/StyledLine/Style/Color/KeyEvent/PasteEvent/InputEvent/
// TerminalCaps), Frame, KeyParser, Terminal, run, stringWidth,
// truncateToWidth, styleToSgr, gradient, rgbTo256, rgbTo16, quantizeColor,
// and the ATTR/CAP/KEY_* constant tables. ffi.ts and buffer.ts internals
// are NOT exported.
