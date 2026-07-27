// ===========================================================================
// @niuma/tui — command palette bottom surface
// ---------------------------------------------------------------------------
// ctrl+p opens a bottom command surface that fuzzy-filters the palette
// items, navigates with up/down (or ctrl+p/ctrl+n), executes on enter and
// closes on esc. `paletteReducer` is pure and returns the next state plus an
// optional `PaletteAction` the app acts on (`execute` / `close`).
//
// The item list is runtime data, not a compile-time constant: the built-in
// UI commands (derived from BUILTIN_COMMANDS in ../commands.ts — no-arg ones
// execute locally, arg-taking ones seed the editor with `/name `) plus the
// session's custom slash commands (commands/*.md templates the server
// expands; the palette seeds the editor with `/name ` so the user can
// supply arguments). `paletteItems()` builds the combined list.
//
// Rendering returns declarative rows plus a relative hardware cursor. The app
// installs it in the mutually-exclusive bottom input slot, preserving the main
// editor draft underneath. Local `PaletteTheme` keeps this independent of the
// product Theme.
// ===========================================================================

import {
  type Color,
  type Cursor,
  type InputEvent,
  matchesKey,
  selectionWindow,
  stringWidth,
  type StyledLine,
  type StyledSpan,
  truncateToWidth,
} from "@niuma/tuikit";

import { BUILTIN_COMMANDS } from "../commands.ts";
import { SELECTION_MARKER, USER_MARKER } from "../symbols.ts";

// ---------------------------------------------------------------------------
// Types + constants
// ---------------------------------------------------------------------------

/** One selectable palette row. `name` carries the leading "/". */
export interface PaletteItem {
  readonly name: string;
  readonly description?: string;
  /** Built-in UI commands execute locally; custom commands seed the editor
   * with `/name ` for the user to complete and submit. */
  readonly builtin: boolean;
  /** Built-ins that take an argument seed the editor (like custom commands)
   * instead of executing on the spot. */
  readonly takesArg?: boolean;
}

/** Minimal shape the palette needs of a server-listed custom command. */
export interface PaletteCommandInfo {
  readonly name: string;
  readonly description?: string;
  readonly argumentHint?: string;
}

export const BUILTIN_PALETTE_ITEMS: readonly PaletteItem[] = [
  ...BUILTIN_COMMANDS.map((c) => ({
    name: `/${c.name}`,
    description: c.description,
    builtin: true,
    takesArg: c.takesArg,
  })),
  // Alias row so "quit" is reachable from the palette too (resolves to /exit
  // in the command parser).
  {
    name: "/quit",
    description: "Quit niuma (alias for /exit)",
    builtin: true,
    takesArg: false,
  },
];

/** Built-ins first, then the session's custom slash commands. */
export const paletteItems = (
  custom: readonly PaletteCommandInfo[],
): readonly PaletteItem[] => [
  ...BUILTIN_PALETTE_ITEMS,
  ...custom.map((c) => ({
    name: `/${c.name}`,
    builtin: false,
    ...(c.description !== undefined ? { description: c.description } : {}),
  })),
];

export interface PaletteState {
  readonly open: boolean;
  readonly query: string;
  /** Grapheme-cluster caret within the query. */
  readonly caret: number;
  /** Index into the filtered list; clamped by the reducer on every change. */
  readonly selected: number;
}

export type PaletteAction =
  | { readonly type: "execute"; readonly item: PaletteItem }
  | { readonly type: "close" };

/** Colors the palette needs. Decoupled from the product `Theme`. */
export interface PaletteTheme {
  readonly border: Color;
  readonly accent: Color;
  readonly text: Color;
  readonly muted: Color;
  readonly prompt: Color;
}

export const initialPaletteState: PaletteState = {
  open: false,
  query: "",
  caret: 0,
  selected: 0,
};

// ---------------------------------------------------------------------------
// Fuzzy filter
// ---------------------------------------------------------------------------

interface Scored {
  readonly item: PaletteItem;
  readonly score: number;
}

/** Rank items against `query` (subsequence match, prefix preferred). */
const fuzzyFilter = (
  query: string,
  items: readonly PaletteItem[],
): readonly Scored[] => {
  const q = query.toLowerCase().trim();
  const out: Scored[] = [];
  for (const item of items) {
    const c = item.name.toLowerCase();
    if (q === "") {
      out.push({ item, score: 0 });
      continue;
    }
    if (c.startsWith(q)) {
      out.push({ item, score: 1000 - c.length });
      continue;
    }
    // subsequence match with contiguous-run bonus
    let qi = 0;
    let contig = 0;
    let maxContig = 0;
    for (let i = 0; i < c.length && qi < q.length; i++) {
      if (c[i] === q[qi]) {
        qi++;
        contig++;
        maxContig = Math.max(maxContig, contig);
      } else {
        contig = 0;
      }
    }
    if (qi === q.length) out.push({ item, score: 10 + maxContig });
  }
  out.sort((a, b) =>
    b.score - a.score || a.item.name.localeCompare(b.item.name)
  );
  return out;
};

/** The filtered item list for a state (what the renderer lists). */
export const paletteFiltered = (
  state: PaletteState,
  items: readonly PaletteItem[],
): readonly PaletteItem[] => fuzzyFilter(state.query, items).map((s) => s.item);

const clamp = (n: number, lo: number, hi: number): number =>
  n < lo ? lo : n > hi ? hi : n;

const segmenter = /* @__PURE__ */ new Intl.Segmenter("en", {
  granularity: "grapheme",
});

const graphemes = (value: string): string[] =>
  Array.from(segmenter.segment(value), (part) => part.segment);

const graphemeCount = (value: string): number => {
  let count = 0;
  for (const _ of segmenter.segment(value)) count++;
  return count;
};

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/** Open the palette (resets query / selection). */
export const openPalette = (state: PaletteState): PaletteState => ({
  ...state,
  open: true,
  query: "",
  caret: 0,
  selected: 0,
});

/** Close the palette (keeps last query, ignored while reopened fresh). */
export const closePalette = (state: PaletteState): PaletteState => ({
  ...state,
  open: false,
});

/**
 * Pure palette reducer. ctrl+p toggles open / moves up once open; ctrl+n moves
 * down. All other events are ignored when closed so the editor keeps working.
 * `items` is the runtime item list (built-ins + custom commands) built once
 * by the app.
 */
export const paletteReducer = (
  state: PaletteState,
  ev: InputEvent,
  items: readonly PaletteItem[],
): readonly [PaletteState, PaletteAction?] => {
  // ctrl+p opens the palette from anywhere.
  if (!state.open) {
    if (ev.kind === "text" && matchesKey(ev, "ctrl+p")) {
      return [openPalette(state), undefined];
    }
    return [state, undefined];
  }

  // -- open: route events --------------------------------------------------
  if (ev.kind === "esc") return [closePalette(state), { type: "close" }];

  if (ev.kind === "text") {
    if (matchesKey(ev, "ctrl+p")) return [move(state, items, -1), undefined];
    if (matchesKey(ev, "ctrl+n")) return [move(state, items, 1), undefined];
    if (matchesKey(ev, "ctrl+c")) {
      return [closePalette(state), { type: "close" }];
    }
    // swallow other ctrl/alt combos
    if (ev.mods.ctrl || ev.mods.alt) return [state, undefined];
    return [appendToQuery(state, ev.text), undefined];
  }

  if (ev.kind === "paste") {
    return [appendToQuery(state, ev.text), undefined];
  }

  // mouse events mean nothing to the palette — leave the state alone.
  if (ev.kind === "mouse") return [state, undefined];

  // named keys
  switch (ev.key) {
    case "enter": {
      const filtered = paletteFiltered(state, items);
      const item = filtered[clamp(state.selected, 0, filtered.length - 1)];
      if (!item) return [closePalette(state), { type: "close" }];
      return [{ ...closePalette(state), selected: 0 }, {
        type: "execute",
        item,
      }];
    }
    case "up":
      return [move(state, items, -1), undefined];
    case "down":
      return [move(state, items, 1), undefined];
    case "left":
      return [{
        ...state,
        caret: clamp(state.caret - 1, 0, state.query.length),
      }, undefined];
    case "right":
      return [{
        ...state,
        caret: clamp(state.caret + 1, 0, graphemeCount(state.query)),
      }, undefined];
    case "home":
      return [{ ...state, caret: 0 }, undefined];
    case "end":
      return [{ ...state, caret: graphemeCount(state.query) }, undefined];
    case "backspace": {
      if (state.caret === 0) return [state, undefined];
      const query = graphemes(state.query);
      query.splice(state.caret - 1, 1);
      const q = query.join("");
      return [
        resetSelection({ ...state, query: q, caret: state.caret - 1 }),
        undefined,
      ];
    }
    case "delete": {
      const query = graphemes(state.query);
      if (state.caret === query.length) return [state, undefined];
      query.splice(state.caret, 1);
      const q = query.join("");
      return [{ ...state, query: q }, undefined];
    }
    case "tab": {
      // tab cycles the selection like many palettes do.
      return [move(state, items, 1), undefined];
    }
    default:
      return [state, undefined];
  }
};

const move = (
  state: PaletteState,
  items: readonly PaletteItem[],
  delta: number,
): PaletteState => {
  const len = paletteFiltered(state, items).length;
  if (len === 0) return state;
  const next = (state.selected + delta + len) % len;
  return { ...state, selected: next };
};

const resetSelection = (state: PaletteState): PaletteState => ({
  ...state,
  selected: 0,
});

const appendToQuery = (state: PaletteState, text: string): PaletteState => {
  if (text === "") return state;
  const query = graphemes(state.query);
  const q = [
    ...query.slice(0, state.caret),
    text,
    ...query.slice(state.caret),
  ].join("");
  return resetSelection({
    ...state,
    query: q,
    caret: state.caret + graphemeCount(text),
  });
};

// ---------------------------------------------------------------------------
// Render
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
const blank = (text: string): StyledSpan => ({ text, style: {} });

export interface PaletteSurface {
  readonly lines: readonly StyledLine[];
  readonly cursor?: Cursor;
}

/**
 * Render the palette input surface: search row, a compact results divider and
 * a windowed selectable list. Selection uses Niuma's marker rather than a
 * reverse-video row.
 */
export const renderPalette = (
  state: PaletteState,
  items: readonly PaletteItem[],
  screenW: number,
  theme: PaletteTheme,
  maxVisible = 8,
): PaletteSurface => {
  const filtered = paletteFiltered(state, items);
  const boxW = Math.max(8, screenW);
  const innerW = Math.max(1, boxW - 4);
  const lines: StyledLine[] = [];

  // top border with a persistent mode label
  const title = truncateToWidth(" commands ", Math.max(0, boxW - 2));
  const titleFill = Math.max(0, boxW - 2 - stringWidth(title));
  lines.push({
    spans: [
      span(TOP_LEFT, theme.border),
      span(title, theme.accent, { bold: true }),
      span(repeat(HBAR, titleFill), theme.border),
      span(TOP_RIGHT, theme.border),
    ],
  });

  // Search input. Keep the part immediately before the caret visible.
  let cursorCol = 4;
  {
    const prompt = `${USER_MARKER} `;
    const queryBudget = Math.max(1, innerW - stringWidth(prompt));
    const spans: StyledSpan[] = [
      span(`${VBAR} `, theme.border),
      span(prompt, theme.prompt, { bold: true }),
    ];
    const query = graphemes(state.query);
    const before = query.slice(0, state.caret).join("");
    const after = query.slice(state.caret).join("");
    const beforeW = stringWidth(before);
    let used = 0;
    if (beforeW < queryBudget) {
      spans.push(span(before, theme.text));
      used = beforeW;
      cursorCol += beforeW;
      const shownAfter = truncateToWidth(after, queryBudget - used);
      spans.push(span(shownAfter, theme.text));
      used += stringWidth(shownAfter);
    } else {
      const tailBudget = Math.max(0, queryBudget - 1);
      const clusters = graphemes(before);
      let tail = "";
      for (let i = clusters.length - 1; i >= 0; i--) {
        const next = clusters[i] + tail;
        if (stringWidth(next) > tailBudget) break;
        tail = next;
      }
      const shown = `…${tail}`;
      spans.push(span(shown, theme.text));
      used = stringWidth(shown);
      cursorCol += used;
    }
    if (used < queryBudget) spans.push(blank(repeat(" ", queryBudget - used)));
    spans.push(span(` ${VBAR}`, theme.border));
    lines.push({ spans });
  }

  const count = ` ${filtered.length} match${
    filtered.length === 1 ? "" : "es"
  } `;
  const countShown = truncateToWidth(count, Math.max(0, boxW - 2));
  lines.push({
    spans: [
      span(T_LEFT, theme.border),
      span(countShown, theme.muted, { dim: true }),
      span(
        repeat(HBAR, Math.max(0, boxW - 2 - stringWidth(countShown))),
        theme.border,
      ),
      span(T_RIGHT, theme.border),
    ],
  });

  const window = selectionWindow(
    { selected: state.selected },
    filtered.length,
    Math.max(1, maxVisible),
  );
  const visible = filtered.slice(window.start, window.end);

  // item rows: marker + command + muted description
  for (let i = 0; i < visible.length; i++) {
    const item = visible[i];
    const selected = window.start + i === window.selected;
    const marker = selected ? `${SELECTION_MARKER} ` : "  ";
    const name = item.name;
    const desc = item.description ?? "";
    const spans: StyledSpan[] = [span(`${VBAR} `, theme.border)];
    spans.push(span(marker, selected ? theme.accent : theme.muted, {
      bold: selected,
    }));
    let used = stringWidth(marker);
    const shownName = truncateToWidth(name, Math.max(0, innerW - used));
    spans.push(span(shownName, selected ? theme.accent : theme.text, {
      bold: selected,
    }));
    used += stringWidth(shownName);
    if (desc !== "" && used + 2 < innerW) {
      const shownDesc = truncateToWidth(desc, innerW - used - 2);
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

  if (visible.length === 0) {
    const message = truncateToWidth("No matching commands", innerW);
    lines.push({
      spans: [
        span(`${VBAR} `, theme.border),
        span(message, theme.muted, { dim: true }),
        blank(repeat(" ", innerW - stringWidth(message))),
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

  return {
    lines,
    cursor: { row: 1, col: Math.min(boxW - 2, cursorCol), shape: "bar" },
  };
};
