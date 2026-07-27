// ===========================================================================
// @niuma/tui — approval bottom panel
// ---------------------------------------------------------------------------
// When an `approval.requested` event arrives the app replaces the bottom input
// slot with a focused approval panel. This module owns:
//   - `ApprovalView` (the view-model the app composes): approvalId + toolName
//     + a pre-rendered input preview (StyledLine[]).
//   - `makeApprovalPreview(input, width, theme)`: builds a shell-ish preview
//     from the raw tool input (stringified, truncated to fit the panel).
//   - `renderApprovalPanel(view, screenW, theme)`: returns the panel rows.
//
// Tool name is shown in a warning color; decisions are a vertical selectable
// list (y/a/n shortcuts plus ↑/↓ + enter). Local
// `ApprovalTheme` keeps this independent of the product `Theme` — `app.ts`
// adapts.
// ===========================================================================

import {
  type Color,
  stringWidth,
  type StyledLine,
  type StyledSpan,
  truncateToWidth,
  wrapLine,
} from "@niuma/tuikit";
import { SELECTION_MARKER } from "../symbols.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApprovalView {
  readonly approvalId: string;
  readonly toolName: string;
  readonly preview: readonly StyledLine[];
  /** Index into {@link APPROVAL_OPTIONS} of the highlighted option. */
  readonly selection: number;
}

/**
 * The three decisions the panel offers, in display order. `key` is the
 * single-letter shortcut that also works while the panel is active.
 */
export const APPROVAL_OPTIONS = [
  { key: "y", label: "Allow once", decision: "once" },
  { key: "a", label: "Always allow", decision: "always" },
  { key: "n", label: "Reject", decision: "reject" },
] as const;

/** Colors the approval panel needs. Decoupled from the product `Theme`. */
export interface ApprovalTheme {
  readonly border: Color;
  readonly warning: Color;
  readonly text: Color;
  readonly muted: Color;
  readonly accent: Color;
}

// ---------------------------------------------------------------------------
// Box drawing
// ---------------------------------------------------------------------------

const TOP_LEFT = "╭";
const TOP_RIGHT = "╮";
const BOTTOM_LEFT = "╰";
const BOTTOM_RIGHT = "╯";
const T_LEFT = "├";
const T_RIGHT = "┤";
const HBAR = "─";
const VBAR = "│";

const repeat = (s: string, n: number): string => s.repeat(Math.max(0, n));

const span = (
  text: string,
  fg: Color,
  extra: { dim?: boolean; bold?: boolean } = {},
): StyledSpan => ({ text, style: { fg, ...extra } });

// ---------------------------------------------------------------------------
// Input preview
// ---------------------------------------------------------------------------

/**
 * Stringify the raw tool input into a shell-ish preview, capped at `maxChars`.
 * Returns "" for empty input. Objects are JSON-stringified on one line so the
 * panel stays compact (multi-line JSON would blow the height budget).
 */
export const stringifyInput = (input: unknown, maxChars = 480): string => {
  let text: string;
  if (input === undefined || input === null) return "";
  if (typeof input === "string") {
    text = input;
  } else {
    try {
      text = JSON.stringify(input);
    } catch {
      text = String(input);
    }
  }
  if (text.length > maxChars) {
    return `${text.slice(0, maxChars)}… (+${
      text.length - maxChars
    } more chars)`;
  }
  return text;
};

/**
 * Build a pre-rendered preview for the panel body. The input is stringified,
 * hard-wrapped to `innerW` cells per line, and capped to a few lines so a huge
 * input never overflows the screen. Each line is a single muted-fg span.
 */
export const makeApprovalPreview = (
  input: unknown,
  innerW: number,
  _theme: ApprovalTheme,
): StyledLine[] => {
  const raw = stringifyInput(input);
  if (raw === "") return [];
  const maxLines = 8;
  const lines: string[] = [];
  for (const piece of raw.split("\n")) {
    // hard-wrap each logical line to innerW cells
    let remaining = piece;
    if (remaining === "") {
      lines.push("");
      if (lines.length >= maxLines) break;
      continue;
    }
    while (remaining.length > 0) {
      const chunk = truncateToWidth(remaining, innerW);
      lines.push(chunk);
      remaining = remaining.slice(chunk.length);
      if (lines.length >= maxLines) break;
    }
    if (lines.length >= maxLines) break;
  }
  if (lines.length >= maxLines && raw.length > lines.join("").length) {
    lines[maxLines - 1] = "… (truncated)";
  }
  return lines.map((l) => ({ spans: [span(l, _theme.muted, { dim: true })] }));
};

// ---------------------------------------------------------------------------
// Panel render
// ---------------------------------------------------------------------------

export interface ApprovalSurface {
  readonly lines: readonly StyledLine[];
}

const EMPTY_PREVIEW: StyledLine = {
  spans: [{ text: "(no input)", style: { dim: true } }],
};

/**
 * Render the approval bottom panel. Input detail is compact and the three
 * decisions remain visible as a vertical list even on narrow terminals.
 */
export const renderApprovalPanel = (
  view: ApprovalView,
  screenW: number,
  theme: ApprovalTheme,
  maxPreviewRows = 5,
): ApprovalSurface => {
  const boxW = Math.max(8, screenW);
  const innerW = Math.max(1, boxW - 4);
  const sourcePreview = view.preview.length > 0
    ? view.preview
    : [EMPTY_PREVIEW];
  const wrappedPreview = sourcePreview.flatMap((line) =>
    wrapLine(line, innerW)
  );
  const preview = wrappedPreview.slice(0, Math.max(1, maxPreviewRows));
  const previewTruncated = wrappedPreview.length > preview.length;

  const lines: StyledLine[] = [];

  // top border with header label
  const label = ` approval required · ${view.toolName} `;
  const labelBudget = Math.max(0, boxW - 2);
  const shownLabel = truncateToWidth(label, labelBudget);
  const topFill = labelBudget - stringWidth(shownLabel);
  lines.push({
    spans: [
      span(TOP_LEFT, theme.border),
      span(shownLabel, theme.warning, { bold: true }),
      span(repeat(HBAR, topFill), theme.border),
      span(TOP_RIGHT, theme.border),
    ],
  });

  // preview body
  for (let i = 0; i < preview.length; i++) {
    const line = preview[i];
    const text = previewTruncated && i === preview.length - 1
      ? "…"
      : line.spans.map((s) => s.text).join("");
    const shown = truncateToWidth(text, innerW);
    const pad = innerW - stringWidth(shown);
    lines.push({
      spans: [
        span(`${VBAR} `, theme.border),
        span(shown, theme.muted),
        span(repeat(" ", Math.max(0, pad)), theme.muted),
        span(` ${VBAR}`, theme.border),
      ],
    });
  }

  const dividerLabel = " choose ";
  const dividerBudget = Math.max(0, boxW - 2);
  lines.push({
    spans: [
      span(T_LEFT, theme.border),
      span(dividerLabel, theme.muted, { dim: true }),
      span(
        repeat(
          HBAR,
          Math.max(0, dividerBudget - stringWidth(dividerLabel)),
        ),
        theme.border,
      ),
      span(T_RIGHT, theme.border),
    ],
  });

  for (let i = 0; i < APPROVAL_OPTIONS.length; i++) {
    const option = APPROVAL_OPTIONS[i];
    const selected = i === view.selection;
    const marker = selected ? `${SELECTION_MARKER} ` : "  ";
    const label = `${option.key}  ${option.label}`;
    const shown = truncateToWidth(
      `${marker}${label}`,
      innerW,
    );
    const used = stringWidth(shown);
    lines.push({
      spans: [
        span(`${VBAR} `, theme.border),
        span(
          shown.slice(0, marker.length),
          selected ? theme.accent : theme.muted,
          { bold: selected },
        ),
        span(
          shown.slice(marker.length),
          selected ? theme.accent : theme.text,
          { bold: selected },
        ),
        span(repeat(" ", Math.max(0, innerW - used)), theme.text),
        span(` ${VBAR}`, theme.border),
      ],
    });
  }

  // bottom border
  lines.push({
    spans: [
      span(BOTTOM_LEFT + repeat(HBAR, boxW - 2) + BOTTOM_RIGHT, theme.border),
    ],
  });

  return { lines };
};
