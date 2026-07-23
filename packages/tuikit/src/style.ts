// ===========================================================================
// @niuma/tuikit — SGR generation, color quantisation, gradient (FFI wrappers)
// ---------------------------------------------------------------------------
// Wraps `tuikit_sgr_style`, `tuikit_rgb_to_256`, `tuikit_rgb_to_16`, and
// `tuikit_gradient`. Quantisation policy lives in the native side (xterm
// 6x6x6 cube + grayscale ramp; nearer by squared RGB distance); these
// wrappers only marshal words and decode the gradient record stream.
// ===========================================================================

import {
  type Color,
  type StyledSpan,
  type Style,
  type TerminalCaps,
} from "./binding-contract.ts";
import {
  acquireBuffer,
  decodeGradient,
  packCaps,
  packColor,
  packStyle,
  releaseBuffer,
  unpackColor,
  withRetry,
} from "./buffer.ts";
import { checkI64, ptrOf, symbols } from "./ffi.ts";

const encoder = /* @__PURE__ */ new TextEncoder();
const decoder = /* @__PURE__ */ new TextDecoder();

/**
 * SGR bytes for a style, quantised to `caps`. The emitted sequence starts
 * with `ESC[0m` (reset) followed by the minimal attributes and colors, so it
 * is safe to emit at any style boundary (exactly what the differ needs).
 */
export const styleToSgr = (
  style: Style,
  caps: TerminalCaps,
): Uint8Array => {
  const { fg, bg, attrs } = packStyle(style);
  const capsWord = packCaps(caps);
  const buf = acquireBuffer(64); // SGR sequences are <= 40 bytes
  try {
    const lib = symbols();
    const call = (outPtr: Deno.PointerValue, cap: number) =>
      lib.tuikit_sgr_style(fg, bg, attrs, capsWord, outPtr, cap);
    const total = withRetry(buf, call);
    // Copy: the pooled buffer will be reused.
    return buf.view.subarray(0, total).slice();
  } finally {
    releaseBuffer(buf);
  }
};

/** rgb -> xterm 256 palette index (16..255). */
export const rgbTo256 = (r: number, g: number, b: number): number =>
  checkI64("tuikit_rgb_to_256", symbols().tuikit_rgb_to_256(r & 0xff, g & 0xff, b & 0xff));

/** rgb -> nearest named-16 palette index (0..15). */
export const rgbTo16 = (r: number, g: number, b: number): number =>
  checkI64("tuikit_rgb_to_16", symbols().tuikit_rgb_to_16(r & 0xff, g & 0xff, b & 0xff));

/**
 * Quantize a Color to what `caps` supports. RGB colors drop to indexed256
 * when truecolor is unavailable, and further to named16 when even 256 is
 * unavailable. Non-RGB colors (named16 / indexed256 / default) are returned
 * unchanged — they already fit any palette.
 */
export const quantizeColor = (c: Color, caps: TerminalCaps): Color => {
  // `default` is a string; the rest are object forms. Only RGB qualifies for
  // quantisation, so narrow to object first to satisfy the `in` operator.
  if (typeof c !== "object" || !("rgb" in c)) return c;
  const [r, g, b] = c.rgb;
  if (caps.truecolor) return c;
  if (caps.color256) return { indexed256: rgbTo256(r, g, b) };
  return { named16: rgbTo16(r, g, b) };
};

/**
 * Paint `text` with a horizontal linear gradient from `from` to `to` (RGB),
 * quantised per `caps`. Returns one StyledSpan per grapheme cluster, fg
 * interpolated linearly over cluster index; a single-cluster text gets `from`.
 *
 * `style.attrs` (bold/italic/etc) and `style.bg` are applied to every span;
 * only `fg` varies. `from`/`to` are plain RGB tuples — this wrapper tags them
 * as required by the native contract.
 */
export const gradient = (
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  text: string,
  style: Style,
  caps: TerminalCaps,
): StyledSpan[] => {
  const textBytes = encoder.encode(text);
  const len = textBytes.length;
  if (len === 0) return [];
  const inPtr = ptrOf(textBytes);
  const fromWord = packColor({ rgb: from });
  const toWord = packColor({ rgb: to });
  const bgWord = packColor(style.bg);
  const capsWord = packCaps(caps);
  // Worst case: one record per byte (all single-byte clusters) = len * 16.
  const buf = acquireBuffer(Math.max(len * 16, 64));
  try {
    const lib = symbols();
    const call = (outPtr: Deno.PointerValue, cap: number) =>
      lib.tuikit_gradient(fromWord, toWord, inPtr, len, bgWord, capsWord, outPtr, cap);
    const total = withRetry(buf, call);
    const recs = decodeGradient(buf.view.subarray(0, total), total);
    const spans: StyledSpan[] = [];
    for (const rec of recs) {
      const slice = textBytes.subarray(rec.byteOfs, rec.byteOfs + rec.byteLen);
      spans.push({
        text: decoder.decode(slice),
        style: {
          ...style,
          fg: unpackColor(rec.fg),
          bg: unpackColor(rec.bg),
        },
      });
    }
    return spans;
  } finally {
    releaseBuffer(buf);
  }
};
