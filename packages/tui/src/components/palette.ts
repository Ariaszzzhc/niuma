// ===========================================================================
// @niuma/tui — command palette overlay (INPUT half)
// ---------------------------------------------------------------------------
// ctrl+p opens a centered command palette that fuzzy-filters a small fixed
// command set, navigates with up/down (or ctrl+p/ctrl+n), executes on enter
// and closes on esc. `paletteReducer` is pure and returns the next state plus
// an optional `PaletteAction` the app acts on (`execute` / `close`).
//
// Rendering mirrors the approval overlay: `renderPalette` returns the modal
// lines + (top, left); the app composites them over a dimmed base scene.
// Local `PaletteTheme` keeps this independent of the A-side `Theme`.
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

// ---------------------------------------------------------------------------
// Types + constants
// ---------------------------------------------------------------------------

export const PALETTE_COMMANDS = ["/model", "/clear", "/quit", "/help"] as const;
export type PaletteCommand = (typeof PALETTE_COMMANDS)[number];

export interface PaletteState {
  readonly open: boolean;
  readonly query: string;
  /** Caret within the query (for a block cursor in the input). */
  readonly caret: number;
  /** Index into the filtered list; clamped by the reducer on every change. */
  readonly selected: number;
}

export type PaletteAction =
  | { readonly type: "execute"; readonly command: PaletteCommand }
  | { readonly type: "close" };

/** Colors the palette needs. Decoupled from the A-side `Theme`. */
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
  readonly cmd: PaletteCommand;
  readonly score: number;
}

/** Rank commands against `query` (subsequence match, prefix preferred). */
const fuzzyFilter = (query: string): readonly Scored[] => {
  const q = query.toLowerCase().trim();
  const out: Scored[] = [];
  for (const cmd of PALETTE_COMMANDS) {
    const c = cmd.toLowerCase();
    if (q === "") {
      out.push({ cmd, score: 0 });
      continue;
    }
    if (c.startsWith(q)) {
      out.push({ cmd, score: 1000 - c.length });
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
    if (qi === q.length) out.push({ cmd, score: 10 + maxContig });
  }
  out.sort((a, b) => b.score - a.score || a.cmd.localeCompare(b.cmd));
  return out;
};

/** The filtered command list for a state (what the renderer lists). */
export const paletteFiltered = (
  state: PaletteState,
): readonly PaletteCommand[] => fuzzyFilter(state.query).map((s) => s.cmd);

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
 */
export const paletteReducer = (
  state: PaletteState,
  ev: InputEvent,
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
    if (matchesKey(ev, "ctrl+p")) return [move(state, -1), undefined];
    if (matchesKey(ev, "ctrl+n")) return [move(state, 1), undefined];
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

  // named keys
  switch (ev.key) {
    case "enter": {
      const filtered = paletteFiltered(state);
      const cmd = filtered[clamp(state.selected, 0, filtered.length - 1)];
      if (!cmd) return [closePalette(state), { type: "close" }];
      return [{ ...closePalette(state), selected: 0 }, {
        type: "execute",
        command: cmd,
      }];
    }
    case "up":
      return [move(state, -1), undefined];
    case "down":
      return [move(state, 1), undefined];
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
      return [move(state, 1), undefined];
    }
    default:
      return [state, undefined];
  }
};

const move = (state: PaletteState, delta: number): PaletteState => {
  const len = paletteFiltered(state).length;
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
 * the filtered commands below with the selection reversed. Returns the lines
 * and the (top, left) where the app stamps them.
 */
export const renderPalette = (
  state: PaletteState,
  screenW: number,
  screenH: number,
  theme: PaletteTheme,
): RenderedOverlay => {
  const filtered = paletteFiltered(state);
  const maxBoxW = Math.max(24, screenW - 2);
  const minBoxW = 28;
  const longest = PALETTE_COMMANDS.reduce(
    (m, c) => Math.max(m, stringWidth(c)),
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

  // command rows
  for (let i = 0; i < filtered.length; i++) {
    const cmd = filtered[i];
    const selected = i === state.selected;
    const label = `  ${cmd}`;
    const shown = truncateToWidth(label, innerW);
    const pad = innerW - stringWidth(shown);
    const spans: StyledSpan[] = [span(`${VBAR} `, theme.border)];
    if (selected) {
      spans.push(span(shown, theme.accent, { reverse: true }));
    } else {
      spans.push(span(shown, theme.text));
    }
    if (!selected && pad > 0) spans.push(blank(repeat(" ", pad)));
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
