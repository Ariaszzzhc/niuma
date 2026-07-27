// ===========================================================================
// @niuma/tui — slash-command completion menu (editor popup)
// ---------------------------------------------------------------------------
// Typing a `/partial` token in the editor pops this menu above the editor
// box (derived in app.ts from the buffer + `slashCommandCandidates`). The
// app owns the interaction semantics (tab accepts, enter accepts + submits,
// esc dismisses, up/down + ctrl+p/ctrl+n navigate); this module holds the
// pure state + the renderer, mirroring palette.ts structure.
//
// The menu is NOT modal: the app stamps its rows over the transcript area
// right above the editor without dimming the base scene.
// ===========================================================================

import {
  type Color,
  selectionWindow,
  stringWidth,
  type StyledLine,
  type StyledSpan,
  truncateToWidth,
} from "@niuma/tuikit";

import type { CompletionCandidate } from "../commands.ts";
import { SELECTION_MARKER } from "../symbols.ts";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface CompletionState {
  /** Index into the current candidate list (clamped by the app on derive). */
  readonly selected: number;
  /** True after esc dismissed the menu; cleared when the buffer changes. */
  readonly dismissed: boolean;
}

export const initialCompletionState: CompletionState = {
  selected: 0,
  dismissed: false,
};

/** Move the selection by `delta`, wrapping around both ends. */
export const moveCompletion = (
  state: CompletionState,
  itemCount: number,
  delta: number,
): CompletionState => {
  if (itemCount <= 0) return state;
  const selected = (state.selected + delta + itemCount) % itemCount;
  return { ...state, selected };
};

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/** Colors the menu needs. Decoupled from the product `Theme`. */
export interface CompletionTheme {
  readonly border: Color;
  readonly accent: Color;
  readonly text: Color;
  readonly muted: Color;
}

/** Cap on visible item rows; longer lists show a window around the selection. */
const MAX_VISIBLE = 8;

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
  extra: { dim?: boolean; bold?: boolean } = {},
): StyledSpan => ({ text, style: { fg, ...extra } });
const blank = (text: string): StyledSpan => ({ text, style: {} });

/**
 * Render the completion menu box: one row per candidate (`/name` + muted
 * description), with a Niuma selection marker instead of reverse-video fill.
 * Longer lists are windowed around the selection.
 */
export const renderCompletionMenu = (
  items: readonly CompletionCandidate[],
  selected: number,
  screenW: number,
  theme: CompletionTheme,
): StyledLine[] => {
  if (items.length === 0) return [];
  const longest = items.reduce(
    (m, c) =>
      Math.max(
        m,
        stringWidth(`/${c.name}`) +
          (c.description !== undefined ? stringWidth(c.description) + 2 : 0),
      ),
    0,
  );
  const boxW = Math.max(1, Math.min(screenW, Math.max(12, longest + 6)));
  const innerW = Math.max(1, boxW - 4);

  const sel = Math.max(0, Math.min(selected, items.length - 1));
  const window = selectionWindow(
    { selected: sel },
    items.length,
    MAX_VISIBLE,
  );
  const windowItems = items.slice(window.start, window.end);

  const lines: StyledLine[] = [];
  lines.push({
    spans: [span(TOP_LEFT + repeat(HBAR, boxW - 2) + TOP_RIGHT, theme.border)],
  });

  for (let i = 0; i < windowItems.length; i++) {
    const item = windowItems[i];
    const isSel = window.start + i === sel;
    const marker = isSel ? `${SELECTION_MARKER} ` : "  ";
    const name = `/${item.name}`;
    const desc = item.description ?? "";
    const spans: StyledSpan[] = [span(`${VBAR} `, theme.border)];
    const markerW = stringWidth(marker);
    spans.push(span(marker, isSel ? theme.accent : theme.muted, {
      bold: isSel,
    }));
    const nameBudget = Math.max(0, innerW - markerW);
    const shownName = truncateToWidth(name, nameBudget);
    spans.push(span(shownName, isSel ? theme.accent : theme.text, {
      bold: isSel,
    }));
    let used = markerW + stringWidth(shownName);
    if (desc !== "" && used + 2 < innerW) {
      const descBudget = innerW - used - 2;
      const shownDesc = truncateToWidth(desc, descBudget);
      if (shownDesc.length > 0) {
        spans.push(blank("  "));
        spans.push(span(shownDesc, theme.muted, { dim: true }));
        used += 2 + stringWidth(shownDesc);
      }
    }
    if (used < innerW) spans.push(blank(repeat(" ", innerW - used)));
    spans.push(span(` ${VBAR}`, theme.border));
    lines.push({ spans });
  }

  lines.push({
    spans: [
      span(BOTTOM_LEFT + repeat(HBAR, boxW - 2) + BOTTOM_RIGHT, theme.border),
    ],
  });
  return lines;
};
