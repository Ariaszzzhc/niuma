// ===========================================================================
// @niuma/tuikit — display width + truncation (thin FFI wrappers)
// ---------------------------------------------------------------------------
// Wraps `tuikit_width` and `tuikit_truncate` from abi.rs. Both operate on
// UTF-8 byte buffers; invalid UTF-8 is tolerated by the native side (each bad
// byte counts as width 1).
//
// No caching here — callers that reuse a string's width should memoise. The
// hot loop in `loop.ts` typically measures width inside the native Frame
// machinery, so these wrappers are mostly for layout in the app layer.
// ===========================================================================

import { acquireBuffer, releaseBuffer, withRetry } from "./buffer.ts";
import { checkI64, ptrOf, symbols } from "./ffi.ts";

const encoder = /* @__PURE__ */ new TextEncoder();
const decoder = /* @__PURE__ */ new TextDecoder();

/**
 * Display width of a string in terminal cells (EAW + hand-written grapheme
 * rules). CJK / fullwidth / wide-emoji clusters = 2; combining marks, control
 * chars, ZWJ / variation selectors = 0; everything else = 1.
 */
export const stringWidth = (s: string): number => {
  const bytes = encoder.encode(s);
  const len = bytes.length;
  if (len === 0) return 0;
  const ptr = ptrOf(bytes);
  const ret = symbols().tuikit_width(ptr, len);
  return checkI64("tuikit_width", ret);
};

/**
 * Truncate `s` to at most `maxWidth` display cells at cluster boundaries. A
 * cluster that would straddle the limit is dropped, never half-drawn. When
 * `ellipsis` is true and truncation occurred, a single "…" (width 1) replaces
 * the clipped tail, fitted within `maxWidth`.
 */
export const truncateToWidth = (
  s: string,
  maxWidth: number,
  ellipsis = false,
): string => {
  const bytes = encoder.encode(s);
  const len = bytes.length;
  if (len === 0) return "";
  const inPtr = ptrOf(bytes);
  const buf = acquireBuffer(len + 4);
  try {
    const lib = symbols();
    const call = (outPtr: Deno.PointerValue, cap: number) =>
      lib.tuikit_truncate(inPtr, len, maxWidth, ellipsis ? 1 : 0, outPtr, cap);
    const total = withRetry(buf, call);
    return decoder.decode(buf.view.subarray(0, total));
  } finally {
    releaseBuffer(buf);
  }
};
