// ===========================================================================
// @niuma/tui — semantic theme palettes + terminal background detection
// ---------------------------------------------------------------------------
// A `Theme` is a bag of semantic Colors (primary / accent / success / warning
// / error / muted / border / text / textDim / codeBg) that the display
// components paint with. Two built-in raw palettes — dark and light — are
// tuned for contrast; `pickTheme(bg, caps)` selects one and quantises every
// colour to what the terminal can actually render (truecolor -> 256 -> 16)
// via tuikit's `quantizeColor`, so a component author always emits the same
// RGB authored value and the palette degrades gracefully on a colour-limited
// terminal.
//
// `detectTerminalBg` queries the terminal for its background colour (OSC 11)
// and classifies it as dark/light by relative luminance, so the app can pick
// a contrasting theme at startup. It falls back to "dark" on any failure
// (no TTY, timeout, locked stdin, unparseable reply) — never throws.
//
// House style: const arrow exports, readonly interfaces, zero new deps.
// ===========================================================================

import type { Color, TerminalCaps } from "@niuma/tuikit";
import { quantizeColor } from "@niuma/tuikit";

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/**
 * Semantic colour palette. Every display component reads colours from here
 * rather than hardcoding RGB, so a single `pickTheme` call re-skins the app.
 * All fields are `Color` (the tuikit currency type); components never need to
 * know whether a value is RGB / 256 / named-16.
 */
export interface Theme {
  readonly primary: Color;
  readonly accent: Color;
  readonly success: Color;
  readonly warning: Color;
  readonly error: Color;
  readonly muted: Color;
  readonly border: Color;
  readonly text: Color;
  readonly textDim: Color;
  readonly codeBg: Color;
}

/** "dark" or "light" background classification. */
export type BgKind = "dark" | "light";

/** Author a colour as RGB (the common case for palette entries). */
const rgb = (r: number, g: number, b: number): Color => ({ rgb: [r, g, b] });

/**
 * Raw (pre-quantisation) palette. Authored as full RGB so `pickTheme` can
 * downgrade to 256/16 per the terminal's real caps without losing the
 * intended hue. Field-for-field compatible with `Theme`.
 */
interface RawPalette {
  readonly primary: Color;
  readonly accent: Color;
  readonly success: Color;
  readonly warning: Color;
  readonly error: Color;
  readonly muted: Color;
  readonly border: Color;
  readonly text: Color;
  readonly textDim: Color;
  readonly codeBg: Color;
}

// Dark palette — light text on a dark background. Blue accents (starship /
// tokyonight family) — primary is a lighter blue, accent a vivid one; muted
// blue-gray for borders.
const DARK_RAW: RawPalette = {
  primary: rgb(122, 180, 255),
  accent: rgb(100, 150, 255),
  success: rgb(80, 220, 140),
  warning: rgb(241, 196, 100),
  error: rgb(255, 110, 110),
  muted: rgb(120, 130, 150),
  border: rgb(88, 110, 150),
  text: rgb(222, 226, 235),
  textDim: rgb(140, 148, 168),
  codeBg: rgb(38, 42, 60),
};

// Light palette — dark text on a light background. Same semantic slots,
// retuned for contrast on light terminals.
const LIGHT_RAW: RawPalette = {
  primary: rgb(40, 90, 200),
  accent: rgb(50, 100, 220),
  success: rgb(20, 150, 80),
  warning: rgb(170, 110, 0),
  error: rgb(200, 50, 50),
  muted: rgb(120, 120, 130),
  border: rgb(150, 155, 165),
  text: rgb(40, 44, 52),
  textDim: rgb(110, 114, 124),
  codeBg: rgb(232, 234, 240),
};

/**
 * The most permissive render caps (full truecolor). Used as the default for
 * the optional `caps` argument taken by gradient-painting components
 * (statusline / banner). Keeping the colour as RGB through `gradient` is
 * lossless: the loop's frame layer re-quantises to the REAL caps at SGR emit
 * time, so defaulting to truecolor here never oversells the terminal.
 */
export const fullColorCaps: TerminalCaps = {
  truecolor: true,
  color256: true,
  kittyKeyboard: false,
  bracketedPaste: false,
  sync2026: false,
};

/**
 * Pick a theme for the given background kind, quantising every colour to the
 * terminal's real caps. RGB endpoints degrade to indexed256 / named16 as
 * needed; already-palette colours pass through unchanged.
 */
export const pickTheme = (bg: BgKind, caps: TerminalCaps): Theme => {
  const raw = bg === "light" ? LIGHT_RAW : DARK_RAW;
  return {
    primary: quantizeColor(raw.primary, caps),
    accent: quantizeColor(raw.accent, caps),
    success: quantizeColor(raw.success, caps),
    warning: quantizeColor(raw.warning, caps),
    error: quantizeColor(raw.error, caps),
    muted: quantizeColor(raw.muted, caps),
    border: quantizeColor(raw.border, caps),
    text: quantizeColor(raw.text, caps),
    textDim: quantizeColor(raw.textDim, caps),
    codeBg: quantizeColor(raw.codeBg, caps),
  };
};

/** Convenience: the built-in dark theme at full colour depth. */
export const darkTheme: Theme = pickTheme("dark", fullColorCaps);
/** Convenience: the built-in light theme at full colour depth. */
export const lightTheme: Theme = pickTheme("light", fullColorCaps);

// ---------------------------------------------------------------------------
// Terminal background detection (OSC 11)
// ---------------------------------------------------------------------------

/**
 * Minimal terminal surface needed by `detectTerminalBg`: a way to write the
 * OSC 11 query. The real tuikit `Terminal` satisfies this structurally
 * (its `write` method), and a plain `{ write }` shim works too. The reply is
 * read straight from `Deno.stdin`, so call this BEFORE `Terminal.open()`
 * grabs the stdin reader; if stdin is already locked the read fails fast and
 * the call falls back to "dark".
 */
export interface BgProbeTerminal {
  readonly write: (bytes: Uint8Array) => Promise<void> | void;
}

// OSC 11 query: "report the default background colour". BEL-terminated (the
// most widely supported form; some terminals answer with ST instead).
const OSC11_QUERY = new TextEncoder().encode("\x1b]11;?\x07");

/** Relative luminance of an sRGB channel (W3C linearisation). */
const channelLum = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/**
 * Classify a background as dark/light from its RGB. Uses W3C relative
 * luminance; the 0.4 threshold biases borderline mid-tones toward "dark"
 * (the same direction as the no-signal fallback), keeping text legible.
 */
export const classifyBg = (r: number, g: number, b: number): BgKind => {
  const L = 0.2126 * channelLum(r) + 0.7152 * channelLum(g) + 0.0722 * channelLum(b);
  return L > 0.4 ? "light" : "dark";
};

/** Decode an xterm OSC 11 colour reply into [r,g,b] (0..255), or null. */
const parseOsc11 = (bytes: Uint8Array): [number, number, number] | null => {
  const text = new TextDecoder().decode(bytes);
  // Replies look like: ESC ] 11 ; rgb:RRRR/GGGG/BBBB ST  (or BEL), with each
  // channel 1..4 hex digits. We scan for the rgb: triple and normalise.
  const m = text.match(/rgb:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)/);
  if (!m) return null;
  const norm = (hex: string): number => {
    const v = parseInt(hex, 16);
    const max = (1 << (hex.length * 4)) - 1; // 16^len - 1
    return Math.round((v * 255) / max);
  };
  return [norm(m[1]), norm(m[2]), norm(m[3])];
};

/**
 * Read up to `timeoutMs` for the OSC 11 reply from stdin. Returns the raw
 * bytes, or null on timeout / error / closed stream. A timed-out read leaves
 * a pending read on stdin (Deno.stdin.read is not cancellable) — acceptable
 * for a one-shot startup probe; the read resolves when stdin closes at exit.
 */
const readReply = async (timeoutMs: number): Promise<Uint8Array | null> => {
  const buf = new Uint8Array(256);
  const readPromise = (async (): Promise<Uint8Array | null> => {
    try {
      const n = await Deno.stdin.read(buf);
      return n && n > 0 ? buf.subarray(0, n) : null;
    } catch {
      // stdin locked (Terminal already grabbed it) or not readable.
      return null;
    }
  })();
  let timer: number | undefined;
  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([readPromise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/**
 * Detect whether the terminal background is dark or light via an OSC 11
 * query. Falls back to "dark" on any failure (no TTY, write error, read
 * timeout, locked stdin, unparseable reply). Never throws.
 *
 * Intended call order: detect the background FIRST (before `Terminal.open()`
 * claims the stdin reader), then open the terminal and pick the theme.
 */
export const detectTerminalBg = async (
  terminal: BgProbeTerminal,
  timeoutMs = 150,
): Promise<BgKind> => {
  // Not a TTY -> no background to query; assume dark.
  try {
    if (!Deno.stdin.isTerminal()) return "dark";
  } catch {
    return "dark";
  }
  try {
    await terminal.write(OSC11_QUERY);
  } catch {
    return "dark";
  }
  const reply = await readReply(timeoutMs);
  if (!reply) return "dark";
  const rgbTriple = parseOsc11(reply);
  if (!rgbTriple) return "dark";
  return classifyBg(...rgbTriple);
};
