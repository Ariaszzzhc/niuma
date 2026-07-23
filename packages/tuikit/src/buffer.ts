// ===========================================================================
// @niuma/tuikit — out-buffer pool + binary record (de)serialisation
// ---------------------------------------------------------------------------
// Every native function that writes variable output follows the same
// "retry dance": TS passes (out_ptr, out_cap); Rust writes min(total, cap)
// and returns the TOTAL bytes needed as i64; if that exceeds cap, TS grows
// the buffer and calls again. `withRetry` centralises that loop.
//
// All cross-boundary records are fixed-layout little-endian binary (no JSON,
// no serde). Encode/decode here uses DataView over JS-owned Uint8Arrays:
//   - SpanRec     : input to tuikit_frame_write_line (24 B/record)
//   - KeyEventRec : output from tuikit_keys_feed     (16 B/record + arena)
//   - GradSpanRec : output from tuikit_gradient      (16 B/record)
//
// Lifetime rule: any pointer handed to Rust is valid only for the duration
// of that call. `encodeSpans` therefore returns the pinned backing so the
// caller can keep it referenced across the synchronous FFI call.
// ===========================================================================

import {
  ATTR,
  CAP,
  COLOR_TAG,
  type Color,
  GRAD_SPAN_REC_OFF,
  GRAD_SPAN_REC_SIZE,
  type InputEvent,
  KEY_CODE,
  KEY_EVENT_REC_OFF,
  KEY_EVENT_REC_SIZE,
  KEY_EVENT_TYPE,
  type KeyEventType,
  KEY_KIND,
  KEYS_OUT_HEADER_SIZE,
  MOD,
  type Style,
  type TerminalCaps,
  type KeyEvent,
  type KeyMods,
  type NamedKey,
  type PasteEvent,
  SPAN_REC_OFF,
  SPAN_REC_SIZE,
  type StyledSpan,
} from "./binding-contract.ts";
import { ptrOf, ptrToBigInt, TuikitError } from "./ffi.ts";

const encoder = /* @__PURE__ */ new TextEncoder();
const decoder = /* @__PURE__ */ new TextDecoder();

/** Convert a native i64/u64 result (bigint or number) to a JS number. */
const toNum = (v: number | bigint): number =>
  typeof v === "bigint" ? Number(v) : v;

// ===========================================================================
// OutBuffer pool
// ===========================================================================

/**
 * A reusable output buffer that grows on demand for the retry dance.
 * `cap`/`view`/`pointer` are read-only views over internal mutable state:
 * growth allocates a new backing array and refreshes the pointer.
 */
export interface OutBuffer {
  /** Current capacity in bytes. */
  readonly cap: number;
  /** Bytes view of the last successful call: `bytes.subarray(0, used)`. */
  readonly view: Uint8Array;
  /** Raw pointer for FFI calls (refreshed on growth). */
  readonly pointer: Deno.PointerValue;
}

/** Smallest power of two >= n (min 16); bounds pool fragmentation. */
const nextPow2 = (n: number): number => {
  let v = 16;
  while (v < n) v <<= 1;
  return v;
};

/** Mutable OutBuffer implementation; mutable fields satisfy the readonly interface. */
class BufferImpl implements OutBuffer {
  bytes: Uint8Array<ArrayBuffer>;
  ptr: Deno.PointerValue;
  used = 0;
  constructor(min: number) {
    this.bytes = new Uint8Array(new ArrayBuffer(nextPow2(min)));
    this.ptr = ptrOf(this.bytes);
  }
  get cap(): number {
    return this.bytes.length;
  }
  get view(): Uint8Array {
    return this.bytes.subarray(0, this.used);
  }
  get pointer(): Deno.PointerValue {
    return this.ptr;
  }
  /** Grow to at least `n` bytes; refreshes the pointer. No-op if already big enough. */
  growTo(n: number): void {
    if (n <= this.bytes.length) return;
    const next = new Uint8Array(new ArrayBuffer(nextPow2(n)));
    next.set(this.bytes);
    this.bytes = next;
    this.ptr = ptrOf(this.bytes);
  }
}

/** Free-list of returned buffers (LIFO keeps the hottest buffer warm). */
const pool: BufferImpl[] = [];

/** Obtain a pooled buffer with at least `min` capacity. */
export const acquireBuffer = (min: number): OutBuffer => {
  const buf = pool.pop() ?? new BufferImpl(min);
  buf.growTo(min);
  buf.used = 0;
  return buf;
};

/** Return a buffer to the pool. Keeps a modest stash, drops the rest. */
export const releaseBuffer = (buf: OutBuffer): void => {
  if (pool.length < 8) pool.push(buf as BufferImpl);
};

/**
 * The retry dance shared by every out-taking native call:
 *   let total = call(buf); while (total > buf.cap) { grow; total = call(buf); }
 * `call` receives the CURRENT (pointer, cap) — it MUST read them fresh on
 * each invocation (i.e. close over `buf`, not snapshot the pointer), because
 * growth invalidates the previous pointer. Returns the final byte count and
 * sets `buf.used`. Throws `TuikitError` on a -1 native fault.
 *
 * For `tuikit_keys_feed` specifically, the contract guarantees that when the
 * return exceeds cap the input was NOT consumed — so re-calling with the same
 * input (which a closure that closes over the input bytes does) is correct.
 */
export const withRetry = (
  buf: OutBuffer,
  call: (ptr: Deno.PointerValue, cap: number) => number | bigint,
): number => {
  const impl = buf as BufferImpl;
  let total = toNum(call(impl.ptr, impl.cap));
  if (total < 0) throw new TuikitError("ffi", "native returned -1 (panic)");
  let guard = 0;
  // total > cap means "needed exceeds capacity" → grow + retry. total == cap
  // fits exactly and must NOT be retried (a same-size re-call would
  // double-feed tuikit_keys_feed). impl.cap/impl.ptr are re-read after
  // growTo, so the call always sees the fresh pointer.
  while (total > impl.cap) {
    if (++guard > 24) {
      throw new TuikitError("ffi", "retry-dance growth loop runaway");
    }
    impl.growTo(total);
    total = toNum(call(impl.ptr, impl.cap));
    if (total < 0) throw new TuikitError("ffi", "native returned -1 (panic)");
  }
  impl.used = total;
  return total;
};

// ===========================================================================
// Color / style packing (TS currency types -> tagged u32 words)
// ===========================================================================

/** Pack a Color (or undefined = default) into its tagged u32 word. */
export const packColor = (c: Color | undefined): number => {
  if (c === undefined || c === "default") {
    return (COLOR_TAG.default << 30) >>> 0;
  }
  if ("named16" in c) {
    return ((COLOR_TAG.named16 << 30) | (c.named16 & 0xff)) >>> 0;
  }
  if ("indexed256" in c) {
    return ((COLOR_TAG.indexed256 << 30) | (c.indexed256 & 0xff)) >>> 0;
  }
  // rgb
  const [r, g, b] = c.rgb;
  return (
    ((COLOR_TAG.rgb << 30) |
      ((r & 0xff) << 16) |
      ((g & 0xff) << 8) |
      (b & 0xff)) >>> 0
  );
};

/** Inverse of {@link packColor}. */
export const unpackColor = (word: number): Color => {
  const w = word >>> 0;
  const tag = (w >>> 30) & 0x3;
  const payload = w & 0x3fffffff;
  switch (tag) {
    case COLOR_TAG.default:
      return "default";
    case COLOR_TAG.named16:
      return { named16: payload & 0xff };
    case COLOR_TAG.indexed256:
      return { indexed256: payload & 0xff };
    case COLOR_TAG.rgb:
      return { rgb: [(payload >>> 16) & 0xff, (payload >>> 8) & 0xff, payload & 0xff] };
    default:
      return "default";
  }
};

/** Pack a Style into (fgWord, bgWord, attrBits). */
export const packStyle = (
  s: Style,
): { readonly fg: number; readonly bg: number; readonly attrs: number } => {
  let attrs = 0;
  if (s.bold) attrs |= ATTR.bold;
  if (s.dim) attrs |= ATTR.dim;
  if (s.italic) attrs |= ATTR.italic;
  if (s.underline) attrs |= ATTR.underline;
  if (s.strikethrough) attrs |= ATTR.strikethrough;
  if (s.reverse) attrs |= ATTR.reverse;
  return { fg: packColor(s.fg), bg: packColor(s.bg), attrs };
};

/** Pack TerminalCaps into the u32 caps bitflag word. */
export const packCaps = (c: TerminalCaps): number => {
  let v = 0;
  if (c.color256) v |= CAP.color256;
  if (c.truecolor) v |= CAP.truecolor;
  if (c.kittyKeyboard) v |= CAP.kittyKeyboard;
  if (c.bracketedPaste) v |= CAP.bracketedPaste;
  if (c.sync2026) v |= CAP.sync2026;
  return v >>> 0;
};

// ===========================================================================
// SpanRec encode (StyledSpan[] -> pinned binary records)
// ===========================================================================

/** Result of {@link encodeSpans}; `backing` MUST outlive the FFI call. */
export interface EncodedSpans {
  /** Pointer to `count` contiguous SpanRec records, or null when count==0. */
  readonly ptr: Deno.PointerValue;
  /** Number of records. */
  readonly count: number;
  /**
   * Opaque keep-alive token: references the records buffer and every span's
   * pinned UTF-8 bytes so GC cannot invalidate the pointers mid-call.
   * Hold this in a local until the native call returns.
   */
  readonly backing: { readonly recs: Uint8Array; readonly texts: Uint8Array[] };
}

/**
 * Serialize a StyledSpan list into pinned SpanRec bytes for
 * `tuikit_frame_write_line`. Layout (LE):
 *   0  u64 text_ptr   8  u32 text_len   12  u32 fg
 *   16 u32 bg         20 u16 attrs     22  u16 _pad(0)
 */
export const encodeSpans = (spans: readonly StyledSpan[]): EncodedSpans => {
  const count = spans.length;
  if (count === 0) {
    return {
      ptr: null,
      count: 0,
      backing: { recs: new Uint8Array(0), texts: [] },
    };
  }
  const recs = new Uint8Array(count * SPAN_REC_SIZE);
  const dv = new DataView(recs.buffer);
  const texts: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const span = spans[i];
    const textBytes = encoder.encode(span.text);
    texts.push(textBytes);
    const { fg, bg, attrs } = packStyle(span.style);
    const base = i * SPAN_REC_SIZE;
    dv.setBigUint64(base + SPAN_REC_OFF.textPtr, ptrToBigInt(textBytes.length === 0 ? null : Deno.UnsafePointer.of(textBytes)), true);
    dv.setUint32(base + SPAN_REC_OFF.textLen, textBytes.length, true);
    dv.setUint32(base + SPAN_REC_OFF.fg, fg, true);
    dv.setUint32(base + SPAN_REC_OFF.bg, bg, true);
    dv.setUint16(base + SPAN_REC_OFF.attrs, attrs, true);
    dv.setUint16(base + 22, 0, true); // _pad
  }
  return {
    ptr: Deno.UnsafePointer.of(recs),
    count,
    backing: { recs, texts },
  };
};

// ===========================================================================
// KeyEventRec decode (out buffer -> InputEvent[])
// ===========================================================================

/** Reverse map of KEY_CODE value -> NamedKey string. */
const NAMED_BY_CODE: Record<number, NamedKey> = /* @__PURE__ */ (() => {
  const out: Record<number, NamedKey> = {};
  for (const [name, code] of Object.entries(KEY_CODE)) {
    if (name === "text") continue;
    out[code as number] = name as NamedKey;
  }
  return out;
})();

const decodeMods = (b: number): KeyMods => ({
  shift: (b & MOD.shift) !== 0,
  alt: (b & MOD.alt) !== 0,
  ctrl: (b & MOD.ctrl) !== 0,
  super: (b & MOD.super) !== 0,
});

const decodeEventType = (et: number): KeyEventType =>
  et === KEY_EVENT_TYPE.repeat
    ? "repeat"
    : et === KEY_EVENT_TYPE.release
    ? "release"
    : "press"; // legacy(0) / press(1)

/**
 * Decode the `tuikit_keys_feed` out buffer into InputEvent[] per the layout:
 *   [0..4)        u32 event_count
 *   [4..4+16N)    N * KeyEventRec
 *   [4+16N..total) payload arena (text / paste bytes)
 * `textOfs` is relative to the buffer start, so payload slices into `buf`.
 */
export const decodeKeyEvents = (
  buf: Uint8Array,
  total: number,
): InputEvent[] => {
  if (total < KEYS_OUT_HEADER_SIZE) return [];
  const limit = Math.min(total, buf.byteLength);
  const dv = new DataView(buf.buffer, buf.byteOffset, limit);
  const count = dv.getUint32(0, true);
  // Clamp to what the buffer actually holds: the native side never emits a
  // count that exceeds the bytes it wrote, but decoding must not throw on a
  // truncated/corrupt buffer (defence at the FFI boundary).
  const maxRecs = Math.max(0, Math.floor((limit - KEYS_OUT_HEADER_SIZE) / KEY_EVENT_REC_SIZE));
  const events: InputEvent[] = [];
  for (let i = 0; i < count && i < maxRecs; i++) {
    const base = KEYS_OUT_HEADER_SIZE + i * KEY_EVENT_REC_SIZE;
    const kind = dv.getUint8(base + KEY_EVENT_REC_OFF.kind);
    const eventType = dv.getUint8(base + KEY_EVENT_REC_OFF.eventType);
    const keyCode = dv.getUint16(base + KEY_EVENT_REC_OFF.keyCode, true);
    const modsByte = dv.getUint8(base + KEY_EVENT_REC_OFF.mods);
    const textLen = dv.getUint16(base + KEY_EVENT_REC_OFF.textLen, true);
    const textOfs = dv.getUint32(base + KEY_EVENT_REC_OFF.textOfs, true);
    const mods = decodeMods(modsByte);
    const et = decodeEventType(eventType);
    // Clamp the payload slice to the buffer; a bogus offset yields "".
    const ofs = Math.min(textOfs, limit);
    const end = Math.min(ofs + textLen, limit);
    const payload = end > ofs ? decoder.decode(buf.subarray(ofs, end)) : "";

    if (kind === KEY_KIND.paste) {
      const ev: PasteEvent = { kind: "paste", text: payload };
      events.push(ev);
      continue;
    }
    if (kind === KEY_KIND.esc) {
      events.push({ kind: "esc" });
      continue;
    }
    // KEY_KIND.key
    if (keyCode === KEY_CODE.text) {
      const ev: KeyEvent = { kind: "text", text: payload, mods, eventType: et };
      events.push(ev);
    } else {
      const named = NAMED_BY_CODE[keyCode];
      if (named !== undefined) {
        const ev: KeyEvent = { kind: "key", key: named, mods, eventType: et };
        events.push(ev);
      }
      // Unknown codes are dropped (forward-compat: reserved code ranges).
    }
  }
  return events;
};

// ===========================================================================
// GradSpanRec decode (gradient out buffer -> fg/bg words per cluster)
// ===========================================================================

/** One cluster's gradient result. */
export interface GradRec {
  readonly byteOfs: number;
  readonly byteLen: number;
  readonly fg: number;
  readonly bg: number;
}

/**
 * Decode `tuikit_gradient` output (N * 16-byte GradSpanRec) into records.
 * The caller pairs each record with the original text slice
 * `[byteOfs, byteOfs+byteLen]`.
 */
export const decodeGradient = (buf: Uint8Array, total: number): GradRec[] => {
  const n = Math.floor(total / GRAD_SPAN_REC_SIZE);
  if (n === 0) return [];
  const dv = new DataView(buf.buffer, buf.byteOffset, Math.min(total, buf.byteLength));
  const out: GradRec[] = [];
  for (let i = 0; i < n; i++) {
    const base = i * GRAD_SPAN_REC_SIZE;
    out.push({
      byteOfs: dv.getUint32(base + GRAD_SPAN_REC_OFF.byteOfs, true),
      byteLen: dv.getUint32(base + GRAD_SPAN_REC_OFF.byteLen, true),
      fg: dv.getUint32(base + GRAD_SPAN_REC_OFF.fg, true),
      bg: dv.getUint32(base + GRAD_SPAN_REC_OFF.bg, true),
    });
  }
  return out;
};
