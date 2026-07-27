// ===========================================================================
// @niuma/tui — command palette overlay (INPUT half)
// ---------------------------------------------------------------------------
// ctrl+p opens a centered command palette that fuzzy-filters the palette
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
// Rendering mirrors the approval overlay: `renderPalette` returns the modal
// lines + (top, left); the app composites them over a dimmed base scene.
// Local `PaletteTheme` keeps the renderer's dependency surface small.
// ===========================================================================

import {
  type Color,
  type InputEvent,
  matchesKey,
  stringWidth,
  type StyledLine,
  type StyledSpan,
  truncateToWidth,
} from "@niuma/tuikit";

import { BUILTIN_COMMANDS } from "../commands.ts";

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
  /** Caret within the query (for a block cursor in the input). */
  readonly caret: number;
  /** Index into the filtered list; clamped by the reducer on every change. */
  readonly selected: number;
}

export type PaletteAction =
  | { readonly type: "execute"; readonly item: PaletteItem }
  | { readonly type: "close" };

/** Focused color interface needed by the palette. */
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
        caret: clamp(state.caret + 1, 0, state.query.length),
      }, undefined];
    case "home":
      return [{ ...state, caret: 0 }, undefined];
    case "end":
      return [{ ...state, caret: state.query.length }, undefined];
    case "backspace": {
      if (state.caret === 0) return [state, undefined];
      const q = state.query.slice(0, state.caret - 1) +
        state.query.slice(state.caret);
      return [
        resetSelection({ ...state, query: q, caret: state.caret - 1 }),
        undefined,
      ];
    }
    case "delete": {
      if (state.caret === state.query.length) return [state, undefined];
      const q = state.query.slice(0, state.caret) +
        state.query.slice(state.caret + 1);
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
  const q = state.query.slice(0, state.caret) + text +
    state.query.slice(state.caret);
  return resetSelection({
    ...state,
    query: q,
    caret: state.caret + text.length,
  });
};

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const TOP_LEFT = "╭";
const TOP_RIGHT = "╮";
const BOTTOM_LEFT = "╰";
const BOTTOM_RIGHT = "╯";
const HBAR = "─";
const VBAR = "│";
const PROMPT = "❯ ";

const repeat = (s: string, n: number): string => s.repeat(Math.max(0, n));
const span = (
  text: string,
  fg: Color,
  extra: { dim?: boolean; bold?: boolean; reverse?: boolean } = {},
): StyledSpan => ({ text, style: { fg, ...extra } });
const blank = (text: string): StyledSpan => ({ text, style: {} });

export interface RenderedOverlay {
  readonly lines: readonly StyledLine[];
  readonly top: number;
  readonly left: number;
}

/**
 * Render the palette modal: an input row (❯ query with a block cursor) on top,
 * the filtered items below (name + muted description, selection reversed).
 * Returns the lines and the (top, left) where the app stamps them.
 */
export const renderPalette = (
  state: PaletteState,
  items: readonly PaletteItem[],
  screenW: number,
  screenH: number,
  theme: PaletteTheme,
): RenderedOverlay => {
  const filtered = paletteFiltered(state, items);
  const maxBoxW = Math.max(24, screenW - 2);
  const minBoxW = 28;
  const longest = items.reduce(
    (m, c) =>
      Math.max(
        m,
        stringWidth(c.name) +
          (c.description !== undefined ? stringWidth(c.description) + 2 : 0),
      ),
    0,
  );
  const queryW = stringWidth(PROMPT + state.query);
  const contentW = Math.max(longest, queryW);
  const boxW = Math.max(minBoxW, Math.min(maxBoxW, contentW + 6));
  const innerW = Math.max(1, boxW - 4);

  const lines: StyledLine[] = [];

  // top border
  lines.push({
    spans: [span(TOP_LEFT + repeat(HBAR, boxW - 2) + TOP_RIGHT, theme.border)],
  });

  // input row: ❯ <query with block cursor>
  {
    const spans: StyledSpan[] = [span(`${VBAR} ${PROMPT}`, theme.prompt)];
    const before = state.query.slice(0, state.caret);
    const beforeW = stringWidth(before);
    if (beforeW >= innerW - stringWidth(PROMPT)) {
      // caret off-screen: show plain truncated query
      spans.push(
        span(
          truncateToWidth(
            state.query,
            Math.max(1, innerW - stringWidth(PROMPT)),
          ),
          theme.text,
        ),
      );
    } else {
      spans.push(span(before, theme.text));
      const cursorChar = state.caret < state.query.length
        ? state.query[state.caret]
        : " ";
      spans.push(span(cursorChar, theme.text, { reverse: true }));
      const used = beforeW + Math.max(1, stringWidth(cursorChar));
      const remain = innerW - stringWidth(PROMPT) - used;
      if (remain > 0) {
        const after = state.caret < state.query.length
          ? state.query.slice(state.caret + 1)
          : "";
        const t = truncateToWidth(after, remain);
        spans.push(span(t, theme.text));
        const pad = remain - stringWidth(t);
        if (pad > 0) spans.push(blank(repeat(" ", pad)));
      }
    }
    spans.push(span(` ${VBAR}`, theme.border));
    lines.push({ spans });
  }

  // item rows: name left, description right-padded after it (muted)
  for (let i = 0; i < filtered.length; i++) {
    const item = filtered[i];
    const selected = i === state.selected;
    const name = `  ${item.name}`;
    const desc = item.description ?? "";
    const nameW = stringWidth(name);
    const descW = stringWidth(desc);
    const gap = 2;
    const spans: StyledSpan[] = [span(`${VBAR} `, theme.border)];
    if (selected) {
      const label = truncateToWidth(
        desc === "" ? name : `${name}${repeat(" ", gap)}${desc}`,
        innerW,
      );
      spans.push(span(label, theme.accent, { reverse: true }));
      const pad = innerW - stringWidth(label);
      if (pad > 0) {
        spans.push(span(repeat(" ", pad), theme.accent, { reverse: true }));
      }
    } else {
      spans.push(span(truncateToWidth(name, innerW), theme.text));
      if (desc !== "" && nameW + gap + descW <= innerW) {
        spans.push(blank(repeat(" ", innerW - nameW - descW)));
        spans.push(span(desc, theme.muted, { dim: true }));
      } else {
        const pad = innerW - Math.min(nameW, innerW);
        if (pad > 0) spans.push(blank(repeat(" ", pad)));
      }
    }
    spans.push(span(` ${VBAR}`, theme.border));
    lines.push({ spans });
  }

  // bottom border
  lines.push({
    spans: [
      span(BOTTOM_LEFT + repeat(HBAR, boxW - 2) + BOTTOM_RIGHT, theme.border),
    ],
  });

  const boxH = lines.length;
  const top = Math.max(0, Math.floor((screenH - boxH) / 3)); // biased toward upper third
  const left = Math.max(0, Math.floor((screenW - boxW) / 2));

  return { lines, top, left };
};
