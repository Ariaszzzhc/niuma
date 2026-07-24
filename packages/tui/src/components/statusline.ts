// ===========================================================================
// @niuma/tui — bottom status line
// ---------------------------------------------------------------------------
// One row pinned to the foot of the screen. Left side: the model id and
// token tallies (dim, so they read as ambient metadata). Right side: when
// the agent is active, the current activity label with a spinner glyph,
// painted with a tuikit horizontal gradient (primary -> accent) so the live
// indicator stands out from the dim metrics.
//
// The renderer fits everything to `width`: the right activity cluster is
// measured first and reserved, then the left metrics are truncated into the
// remaining space. A single StyledLine is returned.
//
// `caps` defaults to full truecolor; the loop's frame layer re-quantises at
// SGR-emit time, so passing truecolor through `gradient` never oversells a
// lower-colour terminal.
// ===========================================================================

import type { StyledLine, StyledSpan, TerminalCaps } from "@niuma/tuikit";
import { gradient, stringWidth, truncateToWidth } from "@niuma/tuikit";
import { fullColorCaps, type Theme } from "../theme.ts";

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** Status-line view model. */
export interface StatusView {
  /** Active model id (e.g. "claude-sonnet-4.5"). */
  readonly model: string;
  /** Input tokens billed so far this session. */
  readonly tokensIn: number;
  /** Output tokens billed so far this session. */
  readonly tokensOut: number;
  /** Short label for what the agent is doing now, or null when idle. */
  readonly activity: string | null;
  /** Current spinner frame index (advances via a tick subscription). */
  readonly spinnerFrame: number;
}

// Braille spinner frames shared with the tool_call component.
const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compact integer formatting: 500 -> "500", 1234 -> "1.2k", 1_500_000 -> "1.5M". */
const formatTokens = (n: number): string => {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const v = n / 1000;
    return `${v >= 100 ? Math.round(v) : v.toFixed(1)}k`;
  }
  const v = n / 1_000_000;
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)}M`;
};

/** Read RGB endpoints off a theme colour (defaults to a neutral grey). */
const toRgb = (c: Theme["primary"]): readonly [number, number, number] => {
  if (typeof c === "object" && "rgb" in c) return c.rgb;
  return [150, 150, 170];
};

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * Render the status line to a single StyledLine that fills exactly `width`.
 */
export const renderStatusline = (
  view: StatusView,
  width: number,
  theme: Theme,
  caps: TerminalCaps = fullColorCaps,
): StyledLine => {
  const safeWidth = Math.max(1, width);

  // -- right cluster: spinner + activity, gradient-painted when active ------
  let rightSpans: StyledSpan[] = [];
  let rightW = 0;
  if (view.activity !== null && view.activity.length > 0) {
    const spinner = SPINNER_FRAMES[view.spinnerFrame % SPINNER_FRAMES.length];
    const text = `${spinner} ${view.activity}`;
    rightSpans = gradient(toRgb(theme.primary), toRgb(theme.accent), text, {
      bold: true,
    }, caps);
    rightW = stringWidth(text);
  }

  // -- left cluster: model + token tallies (dim) ---------------------------
  const metrics = `↑${formatTokens(view.tokensIn)} ↓${
    formatTokens(view.tokensOut)
  }`;
  // "model  metrics" — metrics kept whole; model truncated to fit.
  const gap = "  ";
  const gapW = stringWidth(gap);
  const metricsW = stringWidth(metrics);
  const reservedRight = rightW > 0 ? gapW + rightW : 0;
  // Reserve metrics + their gap; give the rest to the model name.
  const modelBudget = Math.max(
    0,
    safeWidth - metricsW - gapW - reservedRight,
  );
  const modelText = truncateToWidth(view.model, modelBudget, modelBudget > 0);

  const leftSpans: StyledSpan[] = [];
  if (modelText.length > 0) {
    leftSpans.push({
      text: modelText,
      style: { fg: theme.textDim, dim: true },
    });
  }
  if (metricsW > 0) {
    leftSpans.push({ text: gap, style: {} }, {
      text: metrics,
      style: { fg: theme.muted, dim: true },
    });
  }
  const leftW = leftSpans.reduce((n, s) => n + stringWidth(s.text), 0);

  // -- compose: left ... pad ... right -------------------------------------
  const pad = Math.max(0, safeWidth - leftW - rightW);
  const spans: StyledSpan[] = [...leftSpans];
  if (rightW > 0) {
    spans.push({ text: " ".repeat(pad), style: {} }, ...rightSpans);
  } else if (pad > 0) {
    spans.push({ text: " ".repeat(pad), style: {} });
  }

  return { spans };
};
