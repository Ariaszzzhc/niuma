// ===========================================================================
// @niuma/tui — bottom status line
// ---------------------------------------------------------------------------
// One row pinned to the foot of the screen, three clusters:
//
//   left    model id · ↑/↓ token tallies · context fullness ("ctx 12%"),
//           all dim — ambient metadata.
//   centre  cwd (home-abbreviated) · git branch (+ dirty mark) · MCP summary
//           ("mcp 3" once connected; an animated braille spinner while the
//           boot handshake is still pending).
//   right   live activity label with a spinner glyph, gradient-painted
//           (primary -> accent) so it stands out from the dim metrics.
//
// The renderer fits everything to `width`: right (activity) is measured
// first and reserved, then centre (cwd/git/mcp), then the left metrics
// truncate into what remains. A single StyledLine is returned.
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

/** Git state for the workspace, probed out-of-band by the app. */
export interface GitStatus {
  readonly branch: string;
  /** Uncommitted changes present (painted as a warning-coloured ±). */
  readonly dirty: boolean;
}

/** Status-line view model. */
export interface StatusView {
  /** Active model id (e.g. "claude-sonnet-4.5"); "" hides the slot. */
  readonly model: string;
  /** Input tokens billed so far this session. */
  readonly tokensIn: number;
  /** Output tokens billed so far this session. */
  readonly tokensOut: number;
  /** Latest turn's input tokens — the context-fullness proxy. */
  readonly lastInputTokens: number;
  /** Resolved context window, or null when the server didn't report one
   * (the "ctx n%" slot is hidden then). */
  readonly contextWindow: number | null;
  /** Working directory (absolute); home-abbreviated for display. */
  readonly cwd: string;
  /** Git state, or null while probing / outside a repo. */
  readonly git: GitStatus | null;
  /** Connected MCP servers, or null while the boot handshake is pending. */
  readonly mcpServers: ReadonlyArray<{ id: string; toolCount: number }> | null;
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

/** Abbreviate an absolute path: $HOME -> "~", keep the rest verbatim. */
export const abbreviateHome = (path: string): string => {
  let home: string | undefined;
  try {
    home = Deno.env.get("HOME");
  } catch {
    home = undefined;
  }
  if (home !== undefined && home.length > 1 && path.startsWith(home)) {
    return "~" + path.slice(home.length);
  }
  return path;
};

/** Read RGB endpoints off a theme colour (defaults to a neutral grey). */
const toRgb = (c: Theme["primary"]): readonly [number, number, number] => {
  if (typeof c === "object" && "rgb" in c) return c.rgb;
  return [150, 150, 170];
};

const spansWidth = (spans: readonly StyledSpan[]): number =>
  spans.reduce((n, s) => n + stringWidth(s.text), 0);

const GAP = "  ";

/** Drop the leading cluster(s) from a span list until it fits `budget`,
 * truncating the new head as a last resort. Never exceeds `budget`. */
const fitSpans = (
  spans: readonly StyledSpan[],
  budget: number,
): StyledSpan[] => {
  let rest = spans.slice();
  while (rest.length > 0 && spansWidth(rest) > budget) rest = rest.slice(1);
  if (rest.length === 0 || budget <= 0) return [];
  const head = rest[0];
  const headW = stringWidth(head.text);
  if (headW <= budget) return rest;
  return [{
    text: truncateToWidth(head.text, budget, true),
    style: head.style,
  }];
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
  const spinner = SPINNER_FRAMES[view.spinnerFrame % SPINNER_FRAMES.length];

  // -- right cluster: spinner + activity, gradient-painted when active ------
  let rightSpans: StyledSpan[] = [];
  let rightReserved = 0;
  if (view.activity !== null && view.activity.length > 0) {
    const text = `${spinner} ${view.activity}`;
    rightSpans = [
      { text: GAP, style: {} },
      ...gradient(toRgb(theme.primary), toRgb(theme.accent), text, {
        bold: true,
      }, caps),
    ];
    rightReserved = spansWidth(rightSpans);
  }

  // -- centre cluster: cwd · git · mcp --------------------------------------
  const centreSpans: StyledSpan[] = [];
  const pushCentre = (text: string, style: StyledSpan["style"]): void => {
    if (centreSpans.length > 0) centreSpans.push({ text: GAP, style: {} });
    centreSpans.push({ text, style });
  };
  if (view.cwd.length > 0) {
    pushCentre(abbreviateHome(view.cwd), { fg: theme.textDim, dim: true });
  }
  if (view.git !== null && view.git.branch.length > 0) {
    pushCentre(view.git.branch, { fg: theme.muted, dim: true });
    if (view.git.dirty) {
      centreSpans.push({ text: " ", style: {} }, {
        text: "±",
        style: { fg: theme.warning },
      });
    }
  }
  if (view.mcpServers === null) {
    // Boot handshake pending: animate until the server reports its list.
    pushCentre(`${spinner} mcp`, { fg: theme.muted, dim: true });
  } else if (view.mcpServers.length > 0) {
    pushCentre(`mcp ${view.mcpServers.length}`, {
      fg: theme.success,
      dim: true,
    });
  }

  // -- left cluster: model · tokens · context fullness ----------------------
  const leftSpans: StyledSpan[] = [];
  const pushLeft = (text: string, style: StyledSpan["style"]): void => {
    if (leftSpans.length > 0) leftSpans.push({ text: GAP, style: {} });
    leftSpans.push({ text, style });
  };
  if (view.model.length > 0) {
    pushLeft(view.model, { fg: theme.textDim, dim: true });
  }
  pushLeft(
    `↑${formatTokens(view.tokensIn)} ↓${formatTokens(view.tokensOut)}`,
    { fg: theme.muted, dim: true },
  );
  if (view.contextWindow !== null && view.contextWindow > 0) {
    const pct = Math.min(
      999,
      Math.round((view.lastInputTokens / view.contextWindow) * 100),
    );
    pushLeft(`ctx ${pct}%`, { fg: theme.muted, dim: true });
  }

  // -- compose: left · centre · right, worst-fitting cluster drops ----------
  const centreW = spansWidth(centreSpans);
  const centreReserved = centreW > 0 ? centreW + GAP.length : 0;
  const leftBudget = safeWidth - rightReserved - centreReserved;
  const fittedLeft = fitSpans(leftSpans, leftBudget);
  const leftW = spansWidth(fittedLeft);

  let fittedCentre = centreSpans;
  let centreFittedW = centreW;
  if (centreW > 0) {
    const centreBudget = safeWidth - leftW - rightReserved - GAP.length;
    fittedCentre = fitSpans(centreSpans, centreBudget);
    centreFittedW = spansWidth(fittedCentre);
  }

  const spans: StyledSpan[] = [...fittedLeft];
  if (centreFittedW > 0) {
    const pad = safeWidth - leftW - centreFittedW - rightReserved;
    spans.push({ text: " ".repeat(Math.max(1, pad)), style: {} });
    spans.push(...fittedCentre);
  }
  if (rightReserved > 0) {
    const used = spansWidth(spans);
    const pad = safeWidth - used - rightReserved;
    if (pad > 0) spans.push({ text: " ".repeat(pad), style: {} });
    spans.push(...rightSpans);
  }
  // Exact width: top up with trailing space when everything is idle/narrow.
  const total = spansWidth(spans);
  if (total < safeWidth) {
    spans.push({ text: " ".repeat(safeWidth - total), style: {} });
  }

  return { spans };
};
