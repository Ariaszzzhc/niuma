// ===========================================================================
// @niuma/tui — startup banner
// ---------------------------------------------------------------------------
// Two stacked blocks:
//   1. a gradient "niuma" wordmark rendered from a hand-built 4x5 block-glyph
//      font (full-block █ cells), painted left-to-right with a tuikit
//      horizontal gradient (primary -> accent);
//   2. a dim metadata line: `niuma v<version> · <model> · <workspace>`.
//
// Both blocks are centred within `width`. The wordmark rows each carry the
// full gradient so the five rows read as one cohesive rainbow. `caps` defaults
// to full truecolor (the loop re-quantises at emit time, so this never
// oversells a lower-colour terminal).
// ===========================================================================

import type { StyledLine, StyledSpan, TerminalCaps } from "@niuma/tuikit";
import { gradient, stringWidth, truncateToWidth } from "@niuma/tuikit";
import { fullColorCaps, type Theme } from "../theme.ts";

// ---------------------------------------------------------------------------
// 4x5 block-glyph font (█ filled, space empty). Uppercase forms read clearest
// at this size. Each letter is exactly 4 cells wide and 5 rows tall.
// ---------------------------------------------------------------------------

const FONT_B = ["███ ", "█  █", "███ ", "█  █", "███ "];
const FONT_A = [" ██ ", "█  █", "████", "█  █", "█  █"];
const FONT_Z = ["████", "  █ ", " █  ", "█   ", "████"];
const FONT_E = ["████", "█   ", "███ ", "█   ", "████"];

const GLYPH_HEIGHT = 5;
const WORDMARK: readonly (readonly string[])[] = [FONT_B, FONT_A, FONT_Z, FONT_E];
const LETTER_W = 4;
const GAP_W = 1;
// Total wordmark width = 4 letters * 4 + 3 gaps * 1.
const WORDMARK_W = WORDMARK.length * LETTER_W + (WORDMARK.length - 1) * GAP_W;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface BannerOptions {
  readonly version: string;
  readonly model: string;
  readonly workspace: string;
  readonly width: number;
  readonly theme: Theme;
  /** Render caps for the gradient; defaults to full truecolor. */
  readonly caps?: TerminalCaps;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const toRgb = (c: Theme["primary"]): readonly [number, number, number] => {
  if (typeof c === "object" && "rgb" in c) return c.rgb;
  return [150, 150, 170];
};

const centre = (contentW: number, totalW: number): number =>
  Math.max(0, Math.floor((totalW - contentW) / 2));

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * Render the startup banner: a centred gradient "niuma" wordmark followed by a
 * centred dim line of version / model / workspace.
 */
export const renderBanner = (opts: BannerOptions): StyledLine[] => {
  const width = Math.max(1, opts.width);
  const caps = opts.caps ?? fullColorCaps;
  const out: StyledLine[] = [];

  const lead = centre(WORDMARK_W, width);

  // -- wordmark: one gradient row per glyph row, centred -------------------
  for (let r = 0; r < GLYPH_HEIGHT; r++) {
    const rowText = WORDMARK.map((letter) => letter[r]).join(" ");
    const spans = gradient(
      toRgb(opts.theme.primary),
      toRgb(opts.theme.accent),
      rowText,
      { bold: true },
      caps,
    );
    out.push({
      spans: lead > 0
        ? [{ text: " ".repeat(lead), style: {} }, ...spans]
        : spans,
    });
  }

  // -- dim metadata line, centred -----------------------------------------
  const parts = [`niuma v${opts.version}`, opts.model, opts.workspace].filter(
    (p) => p.length > 0,
  );
  const meta = parts.join("  ·  ");
  const metaW = stringWidth(meta);
  const metaLead = centre(metaW, width);
  const metaSpans: StyledSpan[] = metaLead > 0
    ? [{ text: " ".repeat(metaLead), style: {} }]
    : [];
  metaSpans.push({
    text: truncateToWidth(meta, Math.max(1, width - metaLead), false),
    style: { fg: opts.theme.textDim, dim: true },
  });
  out.push({ spans: metaSpans });

  return out;
};
