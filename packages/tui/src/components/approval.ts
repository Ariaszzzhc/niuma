// ===========================================================================
// @niuma/tui — approval modal overlay (INPUT half)
// ---------------------------------------------------------------------------
// When an `approval.requested` event arrives the app raises a centered modal
// over a dimmed base scene. This module owns:
//   - `ApprovalView` (the view-model the app composes): approvalId + toolName
//     + a pre-rendered input preview (StyledLine[]).
//   - `makeApprovalPreview(input, width, theme)`: builds a shell-ish preview
//     from the raw tool input (stringified, truncated to fit the modal).
//   - `renderApprovalOverlay(view, screenW, screenH, theme)`: returns the
//     modal's lines plus the (top, left) position where the app should stamp
//     them. The dimming + compositing lives in `app.ts` (it has the base
//     scene); this module only renders the modal chrome.
//
// The modal is a rounded box centered on screen. Tool name is shown in a
// warning color; the option row lists the decisions (y/a/n shortcuts plus
// ↑/↓ + enter navigation — the selected item is reverse-video). Local
// `ApprovalTheme` keeps this independent of the A-side `Theme` — `app.ts`
// adapts.
// ===========================================================================

import {
  type Color,
  stringWidth,
  type StyledLine,
  type StyledSpan,
  truncateToWidth,
} from "@niuma/tuikit";

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
 * The three decisions the modal offers, in display order. `key` is the
 * single-letter shortcut that also works while the modal is up.
 */
export const APPROVAL_OPTIONS = [
  { key: "y", label: "yes, once", decision: "once" },
  { key: "a", label: "yes, always", decision: "always" },
  { key: "n", label: "no, reject", decision: "reject" },
] as const;

/** Colors the approval modal needs. Decoupled from the A-side `Theme`. */
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
const HBAR = "─";
const VBAR = "│";

const repeat = (s: string, n: number): string => s.repeat(Math.max(0, n));

const span = (
  text: string,
  fg: Color,
  extra: { dim?: boolean; bold?: boolean; reverse?: boolean } = {},
): StyledSpan => ({ text, style: { fg, ...extra } });

// ---------------------------------------------------------------------------
// Input preview
// ---------------------------------------------------------------------------

/**
 * Stringify the raw tool input into a shell-ish preview, capped at `maxChars`.
 * Returns "" for empty input. Objects are JSON-stringified on one line so the
 * modal stays compact (multi-line JSON would blow the height budget).
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
 * Build a pre-rendered preview for the modal body. The input is stringified,
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
// Overlay render
// ---------------------------------------------------------------------------

export interface RenderedOverlay {
  readonly lines: readonly StyledLine[];
  readonly top: number;
  readonly left: number;
}

const EMPTY_PREVIEW: StyledLine = {
  spans: [{ text: "(no input)", style: { dim: true } }],
};

/**
 * Render the approval modal. Returns the modal lines (border + header + preview
 * + footer) and the (top, left) screen cell where the first line goes. The
 * caller (`app.ts`) composites these over the dimmed base scene.
 *
 * Layout: width = clamp(content + padding, 40, screenW - 2); height adapts.
 */
export const renderApprovalOverlay = (
  view: ApprovalView,
  screenW: number,
  screenH: number,
  theme: ApprovalTheme,
): RenderedOverlay => {
  const maxBoxW = Math.max(20, screenW - 2);
  const minBoxW = 40;

  // Determine content width from the header + options + preview.
  const headerText = ` approval required: ${view.toolName} `;
  const optionsW = APPROVAL_OPTIONS.reduce(
    (w, o, i) => w + stringWidth(o.label) + 6 + (i > 0 ? 3 : 0),
    0,
  );
  const headerW = stringWidth(headerText);
  let previewInner = 0;
  for (const line of view.preview) {
    for (const s of line.spans) {
      previewInner = Math.max(previewInner, stringWidth(s.text));
    }
  }
  const contentW = Math.max(headerW - 2, optionsW, previewInner);
  const boxW = Math.max(minBoxW, Math.min(maxBoxW, contentW + 4));
  const innerW = Math.max(1, boxW - 4);

  // Re-wrap preview to the final inner width if it differs.
  const preview = view.preview.length > 0 ? view.preview : [EMPTY_PREVIEW];

  const lines: StyledLine[] = [];

  // top border with header label. The label is truncated to the inner border
  // budget (boxW - 2) so a long tool name on a narrow screen can never make
  // the header row wider than the modal's left/right corners + bottom border.
  const label = ` approval required: ${view.toolName} `;
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

  // a blank padding row
  lines.push({
    spans: [
      span(`${VBAR} `, theme.border),
      span(repeat(" ", innerW), theme.text),
      span(` ${VBAR}`, theme.border),
    ],
  });

  // preview body (truncated to innerW)
  for (const line of preview) {
    const text = line.spans.map((s) => s.text).join("");
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

  // blank padding row
  lines.push({
    spans: [
      span(`${VBAR} `, theme.border),
      span(repeat(" ", innerW), theme.text),
      span(` ${VBAR}`, theme.border),
    ],
  });

  // option row: one item per decision; the selected item is stamped in
  // reverse video so ↑/↓ navigation is visible at a glance.
  {
    const optionSpans: StyledSpan[] = [span(`${VBAR} `, theme.border)];
    let used = 0;
    APPROVAL_OPTIONS.forEach((o, i) => {
      if (i > 0) {
        optionSpans.push(span("   ", theme.muted));
        used += 3;
      }
      const item = `${o.key}  ${o.label}`;
      const selected = i === view.selection;
      optionSpans.push(
        selected
          ? span(item, theme.accent, { reverse: true, bold: true })
          : span(item, theme.text),
      );
      used += stringWidth(item);
    });
    const pad = innerW - used;
    if (pad > 0) optionSpans.push(span(repeat(" ", pad), theme.border));
    optionSpans.push(span(` ${VBAR}`, theme.border));
    lines.push({ spans: optionSpans });
  }

  // bottom border
  lines.push({
    spans: [
      span(BOTTOM_LEFT + repeat(HBAR, boxW - 2) + BOTTOM_RIGHT, theme.border),
    ],
  });

  const boxH = lines.length;
  const top = Math.max(0, Math.floor((screenH - boxH) / 2));
  const left = Math.max(0, Math.floor((screenW - boxW) / 2));

  return { lines, top, left };
};
