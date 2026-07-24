// ===========================================================================
// @niuma/tui — tool_call transcript card (collapsed + expanded views)
// ---------------------------------------------------------------------------
// Renders one tool call as it appears in the transcript. Collapsed form is a
// single row: a status glyph, the tool name, an input summary, and (when
// known) the elapsed time. Expanded form appends the result lines tree-
// indented under a "⎿ " branch, capped at 8 lines with a "+N lines" footer.
//
//   collapsed:   ⠙ read_file  src/main.ts
//   expanded:    ● read_file  src/main.ts   120ms
//                ⎿ line one
//                  line two
//                  +3 lines
//
// Status glyphs: a braille spinner (animated by the caller via `spinnerFrame`)
// while running, ● in the success colour when done, ✗ in the error colour on
// failure. The spinner frame index is an optional trailing argument so the
// base signature renderToolCall(call, width, theme) still works (frame 0).
// ===========================================================================

import type { StyledLine, StyledSpan } from "@niuma/tuikit";
import { stringWidth, truncateToWidth } from "@niuma/tuikit";
import type { Theme } from "../theme.ts";

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** Lifecycle of a single tool call, for display. */
export type ToolCallStatus = "running" | "done" | "error";

/**
 * A tool call's display model. `resultLines` are the (already stringified)
 * lines of the tool result; `expanded` toggles the tree view; `durationMs`
 * is shown when the call has finished.
 */
export interface ToolCallView {
  readonly name: string;
  readonly status: ToolCallStatus;
  /** Short one-line summary of the input (e.g. the file path / command). */
  readonly inputSummary: string;
  /** Stringified result lines, already trimmed to display text. */
  readonly resultLines: readonly string[];
  /** Elapsed time in ms; shown when present. */
  readonly durationMs?: number;
  /** Show the tree-indented result block beneath the header. */
  readonly expanded: boolean;
}

// Braille spinner frames (each width 1). Animated by passing an advancing
// `spinnerFrame`; the index wraps modulo the cycle length.
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

/** Maximum result lines shown when expanded; the rest collapse into a footer. */
const MAX_RESULT_LINES = 8;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** "1234ms" -> "1.2s"; small values stay in ms for precision. */
const formatDuration = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

/** Read the status glyph + colour for the header. */
const statusGlyph = (
  call: ToolCallView,
  spinnerFrame: number,
  theme: Theme,
): StyledSpan => {
  switch (call.status) {
    case "running":
      return {
        text: SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length],
        style: { fg: theme.accent },
      };
    case "done":
      return { text: "●", style: { fg: theme.success } };
    case "error":
      return { text: "✗", style: { fg: theme.error } };
  }
};

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * Render a tool call. Pass the current spinner frame as the 4th argument to
 * animate the running glyph; it defaults to 0 so the base call shape
 * `renderToolCall(call, width, theme)` also works (frozen at frame 0).
 */
export const renderToolCall = (
  call: ToolCallView,
  width: number,
  theme: Theme,
  spinnerFrame = 0,
): StyledLine[] => {
  const safeWidth = Math.max(1, width);
  const out: StyledLine[] = [];

  // -- header row ----------------------------------------------------------
  const glyph = statusGlyph(call, spinnerFrame, theme);
  const nameSpan: StyledSpan = {
    text: call.name,
    style: { fg: theme.text, bold: true },
  };
  const headerLeft: StyledSpan[] = [
    glyph,
    { text: " ", style: {} },
    nameSpan,
  ];

  // Right-aligned duration (if any) is reserved first so the summary can take
  // whatever remains without overflowing.
  const durText = call.durationMs !== undefined
    ? formatDuration(call.durationMs)
    : "";
  const durSpan: StyledSpan = {
    text: durText,
    style: { fg: theme.textDim, dim: true },
  };
  const durW = stringWidth(durText);

  const usedW = headerLeft.reduce((n, s) => n + stringWidth(s.text), 0); // glyph+space+name
  const gap = "  ";
  const gapW = stringWidth(gap);
  // Budget for the summary: width - used - gap - (duration + its gap) - right pad.
  const reserved = usedW + gapW + (durW > 0 ? gapW + durW : 0);
  const summaryBudget = Math.max(0, safeWidth - reserved);

  const summaryText = call.inputSummary.length > 0
    ? truncateToWidth(call.inputSummary, summaryBudget, summaryBudget > 0)
    : "";
  const summarySpan: StyledSpan = {
    text: summaryText,
    style: { fg: theme.muted },
  };

  // Lay out: [headerLeft] [gap][summary] ... pad ... [gap][duration]
  const headerSpans: StyledSpan[] = [...headerLeft];
  if (summaryText.length > 0) {
    headerSpans.push({ text: gap, style: {} }, summarySpan);
  }
  const leftW = headerSpans.reduce((n, s) => n + stringWidth(s.text), 0);
  const pad = Math.max(0, safeWidth - leftW - (durW > 0 ? gapW + durW : 0));
  if (pad > 0) headerSpans.push({ text: " ".repeat(pad), style: {} });
  if (durW > 0) headerSpans.push({ text: gap, style: {} }, durSpan);

  out.push({ spans: headerSpans });

  // -- expanded result block ----------------------------------------------
  if (call.expanded && call.resultLines.length > 0) {
    const total = call.resultLines.length;
    const shown = call.resultLines.slice(0, MAX_RESULT_LINES);
    const hidden = total - shown.length;

    shown.forEach((line, idx) => {
      const branch = idx === 0 ? "⎿ " : "  ";
      const branchSpan: StyledSpan = {
        text: branch,
        style: { fg: theme.border },
      };
      const innerW = Math.max(1, safeWidth - stringWidth(branch));
      const clipped = truncateToWidth(line, innerW, false);
      out.push({
        spans: [branchSpan, { text: clipped, style: { fg: theme.textDim } }],
      });
    });
    if (hidden > 0) {
      out.push({
        spans: [
          { text: "  ", style: {} },
          {
            text: `+${hidden} line${hidden === 1 ? "" : "s"}`,
            style: { fg: theme.muted, dim: true },
          },
        ],
      });
    }
  }

  return out;
};
