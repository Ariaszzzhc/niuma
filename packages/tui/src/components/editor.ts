// ===========================================================================
// @niuma/tui — prompt editor component (INPUT half)
// ---------------------------------------------------------------------------
// A small multi-line text editor with a rounded border, dim placeholder and a
// block-cursor cell. Pure: `editorReducer(state, ev)` returns a new state
// (plus an optional `EditorAction` the app acts on — currently only `submit`).
//
// The reducer accepts an `InputEvent` (KeyEvent | PasteEvent) rather than a
// bare `KeyEvent` so bracketed-paste inserts work — the TEA loop delivers the
// full `InputEvent` via `KeyMsg.event`, so this is the natural currency.
//
// Editing model:
//   - `lines` is always >= 1 entry; an empty editor is `[""]`.
//   - `cursor` is (row, col) where `col` is a GRAPHEME-CLUSTER offset within
//     the line (not a UTF-16 code-unit offset). Intl.Segmenter splits the line
//     into extended grapheme clusters, so a multi-code-point emoji / ZWJ
//     sequence / combining chain moves and renders as a single cell. The
//     surrounding text still flows through the width-aware truncators.
//   - submit = plain `enter` (and `ctrl+m`). `shift+enter` inserts a newline
//     (kitty delivers it as enter+shift; legacy terminals cannot express it,
//     so plain enter submits there — matching the spec).
//   - up/down recall history when the buffer is a single line, and move the
//     caret between rows once the buffer is multi-line.
//   - `ctrl+a/e/u/k/w` readline-style kills (no persistent kill ring yet — the
//     killed text is dropped; the hook is named so a ring can be added later).
//
// Block cursor: the cell under the caret is drawn in reverse video (rather
// than driving the terminal's hardware cursor, which the loop hides). This
// composes cleanly with the alt-screen / CSI-2026 diff path.
//
// Theme: this component defines its OWN `EditorTheme` shape (the few colors it
// needs) so it is independent of the A-side `Theme`. `app.ts` adapts the
// real `Theme` to it — see `editorThemeFromTheme` interlock note.
// ===========================================================================

import {
  type Color,
  type InputEvent,
  type StyledLine,
  type StyledSpan,
  matchesKey,
  stringWidth,
  truncateToWidth,
} from "@niuma/tuikit";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EditorCursor {
  readonly row: number;
  readonly col: number;
}

export interface EditorState {
  /** One string per logical line; never empty (`[""]` for a blank editor). */
  readonly lines: readonly string[];
  readonly cursor: EditorCursor;
  readonly placeholder: string;
  /** Submitted prompts, oldest first. */
  readonly history: readonly string[];
  /** Index into `history` while recalling, or `null` while editing a fresh draft. */
  readonly historyCursor: number | null;
  /** Draft captured when history browsing began; restored on `down` past newest. */
  readonly savedDraft: string;
}

export type EditorAction = { readonly type: "submit"; readonly text: string };

/** Colors the editor needs. Decoupled from the A-side `Theme`. */
export interface EditorTheme {
  readonly border: Color;
  readonly accent: Color;
  readonly text: Color;
  readonly placeholder: Color;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export const createEditorState = (
  placeholder = "Send a message…  (enter to submit, shift+enter for newline)",
): EditorState => ({
  lines: [""],
  cursor: { row: 0, col: 0 },
  placeholder,
  history: [],
  historyCursor: null,
  savedDraft: "",
});

/** Whether the editor currently holds any non-newline text. */
export const editorIsEmpty = (state: EditorState): boolean =>
  state.lines.length === 1 && state.lines[0] === "";

/** Flatten the editor buffer to a single string (newline-joined). */
export const editorText = (state: EditorState): string => state.lines.join("\n");

// ---------------------------------------------------------------------------
// Internal helpers (pure)
// ---------------------------------------------------------------------------

const withCursor = (
  state: EditorState,
  lines: readonly string[],
  row: number,
  col: number,
): EditorState => ({
  ...state,
  lines,
  cursor: { row, col },
});

// ---------------------------------------------------------------------------
// Grapheme-cluster helpers
// ---------------------------------------------------------------------------
//
// `cursor.col` is a grapheme-cluster index, so every primitive that slices a
// line by the caret must operate on cluster boundaries, not UTF-16 code units.
// A single Intl.Segmenter (reused across all calls) splits a line into
// extended grapheme clusters: a multi-code-point emoji, a ZWJ family sequence,
// or a base+combining-mark chain each count as ONE cluster / ONE caret step.

const graphemeSegmenter = /* @__PURE__ */ new Intl.Segmenter("en", {
  granularity: "grapheme",
});

/** Split `s` into its extended grapheme-cluster substrings. */
const graphemes = (s: string): string[] => {
  const out: string[] = [];
  for (const seg of graphemeSegmenter.segment(s)) out.push(seg.segment);
  return out;
};

/** Number of grapheme clusters in `s`. */
const graphemeCount = (s: string): number => {
  let n = 0;
  for (const _ of graphemeSegmenter.segment(s)) n++;
  return n;
};

/** Insert `text` at the caret (cluster boundary), splitting on embedded newlines. */
const insertText = (state: EditorState, text: string): EditorState => {
  if (text === "") return state;
  const { lines, cursor } = state;
  const row = cursor.row;
  const gs = graphemes(lines[row]);
  const before = gs.slice(0, cursor.col).join("");
  const after = gs.slice(cursor.col).join("");
  if (!text.includes("\n")) {
    const newLines = lines.slice();
    newLines[row] = before + text + after;
    return withCursor(state, newLines, row, cursor.col + graphemeCount(text));
  }
  const segs = text.split("\n");
  const newLines = [
    ...lines.slice(0, row),
    before + segs[0],
    ...segs.slice(1, -1),
    segs[segs.length - 1] + after,
  ];
  return withCursor(
    state,
    newLines,
    row + segs.length - 1,
    graphemeCount(segs[segs.length - 1]),
  );
};

const deleteBackward = (state: EditorState): EditorState => {
  const { lines, cursor } = state;
  const { row, col } = cursor;
  if (col === 0) {
    if (row === 0) return state;
    const prevClusters = graphemeCount(lines[row - 1]);
    const newLines = lines.slice();
    newLines[row - 1] = lines[row - 1] + lines[row];
    newLines.splice(row, 1);
    return withCursor(state, newLines, row - 1, prevClusters);
  }
  const gs = graphemes(lines[row]);
  gs.splice(col - 1, 1);
  const newLines = lines.slice();
  newLines[row] = gs.join("");
  return withCursor(state, newLines, row, col - 1);
};

const deleteForward = (state: EditorState): EditorState => {
  const { lines, cursor } = state;
  const { row, col } = cursor;
  if (col === graphemeCount(lines[row])) {
    if (row === lines.length - 1) return state;
    const newLines = lines.slice();
    newLines[row] = lines[row] + lines[row + 1];
    newLines.splice(row + 1, 1);
    return state;
  }
  const gs = graphemes(lines[row]);
  gs.splice(col, 1);
  const newLines = lines.slice();
  newLines[row] = gs.join("");
  return { ...state, lines: newLines };
};

const moveLeft = (state: EditorState): EditorState => {
  const { lines, cursor } = state;
  const { row, col } = cursor;
  if (col > 0) return { ...state, cursor: { row, col: col - 1 } };
  if (row > 0) return { ...state, cursor: { row: row - 1, col: graphemeCount(lines[row - 1]) } };
  return state;
};

const moveRight = (state: EditorState): EditorState => {
  const { lines, cursor } = state;
  const { row, col } = cursor;
  if (col < graphemeCount(lines[row])) {
    return { ...state, cursor: { row, col: col + 1 } };
  }
  if (row < lines.length - 1) return { ...state, cursor: { row: row + 1, col: 0 } };
  return state;
};

const moveUp = (state: EditorState): EditorState => {
  const { lines, cursor } = state;
  if (cursor.row === 0) return state;
  const row = cursor.row - 1;
  return { ...state, cursor: { row, col: Math.min(cursor.col, graphemeCount(lines[row])) } };
};

const moveDown = (state: EditorState): EditorState => {
  const { lines, cursor } = state;
  if (cursor.row === lines.length - 1) return state;
  const row = cursor.row + 1;
  return { ...state, cursor: { row, col: Math.min(cursor.col, graphemeCount(lines[row])) } };
};

// -- flat-position word jumps (grapheme-cluster based; "\n" is a separator
//    cluster so jumps cross rows) --------------------------------------------

/** Flatten the buffer to a grapheme-cluster array (rows joined by "\n") plus
 *  the caret's cluster index. Cluster granularity keeps ZWJ/emoji sequences
 *  intact as a single jump unit. */
const toFlat = (state: EditorState): { clusters: string[]; pos: number } => {
  const clusters: string[] = [];
  for (let i = 0; i < state.lines.length; i++) {
    if (i > 0) clusters.push("\n");
    for (const g of graphemes(state.lines[i])) clusters.push(g);
  }
  let pos = 0;
  for (let i = 0; i < state.cursor.row; i++) pos += graphemeCount(state.lines[i]) + 1;
  pos += state.cursor.col;
  return { clusters, pos };
};

const fromFlat = (
  lines: readonly string[],
  pos: number,
): { row: number; col: number } => {
  let remaining = pos;
  for (let row = 0; row < lines.length; row++) {
    const lineClusters = graphemeCount(lines[row]);
    if (remaining <= lineClusters) return { row, col: remaining };
    remaining -= lineClusters + 1;
  }
  const last = lines.length - 1;
  return { row: last, col: graphemeCount(lines[last]) };
};

/** A cluster counts as whitespace only when it is a single whitespace char. */
const isWs = (g: string): boolean =>
  g === " " || g === "\t" || g === "\n" || g === "\r";

const wordLeft = (clusters: readonly string[], pos: number): number => {
  let i = pos;
  while (i > 0 && isWs(clusters[i - 1])) i--;
  while (i > 0 && !isWs(clusters[i - 1])) i--;
  return i;
};

const wordRight = (clusters: readonly string[], pos: number): number => {
  let i = pos;
  // skip the current (trailing) word
  while (i < clusters.length && !isWs(clusters[i])) i++;
  // then skip whitespace to land at the start of the next word
  while (i < clusters.length && isWs(clusters[i])) i++;
  return i;
};

/** Rebuild state from a cluster array + caret cluster position. */
const rebuild = (
  state: EditorState,
  clusters: readonly string[],
  pos: number,
): EditorState => {
  const text = clusters.join("");
  const lines = text.split("\n");
  const cursor = fromFlat(lines, pos);
  return { ...state, lines, cursor };
};

const moveWordLeft = (state: EditorState): EditorState => {
  const { clusters, pos } = toFlat(state);
  return rebuild(state, clusters, wordLeft(clusters, pos));
};

const moveWordRight = (state: EditorState): EditorState => {
  const { clusters, pos } = toFlat(state);
  return rebuild(state, clusters, wordRight(clusters, pos));
};

// -- readline-style kills (kill text dropped; ring is a future hook) --------

const killWordBack = (state: EditorState): EditorState => {
  const { clusters, pos } = toFlat(state);
  const newPos = wordLeft(clusters, pos);
  if (newPos === pos) return state;
  const next = clusters.slice(0, newPos).concat(clusters.slice(pos));
  return rebuild(state, next, newPos);
};

const killToLineStart = (state: EditorState): EditorState => {
  const { lines, cursor } = state;
  if (cursor.col === 0) return state;
  const gs = graphemes(lines[cursor.row]);
  const newLines = lines.slice();
  newLines[cursor.row] = gs.slice(cursor.col).join("");
  return withCursor(state, newLines, cursor.row, 0);
};

const killToLineEnd = (state: EditorState): EditorState => {
  const { lines, cursor } = state;
  if (cursor.col === graphemeCount(lines[cursor.row])) return state;
  const gs = graphemes(lines[cursor.row]);
  const newLines = lines.slice();
  newLines[cursor.row] = gs.slice(0, cursor.col).join("");
  return { ...state, lines: newLines };
};

const moveLineStart = (state: EditorState): EditorState => ({
  ...state,
  cursor: { ...state.cursor, col: 0 },
});

const moveLineEnd = (state: EditorState): EditorState => ({
  ...state,
  cursor: { ...state.cursor, col: graphemeCount(state.lines[state.cursor.row]) },
});

// -- history ----------------------------------------------------------------

const recall = (state: EditorState, idx: number): EditorState => {
  const text = state.history[idx] ?? "";
  const lines = text.split("\n");
  const last = lines.length - 1;
  return {
    ...state,
    lines,
    cursor: { row: last, col: graphemeCount(lines[last]) },
    historyCursor: idx,
  };
};

const historyUp = (state: EditorState): EditorState => {
  if (state.history.length === 0) return state;
  const idx = state.historyCursor === null
    ? state.history.length - 1
    : state.historyCursor - 1;
  if (idx < 0) return state;
  const savedDraft = state.historyCursor === null
    ? state.lines.join("\n")
    : state.savedDraft;
  return { ...recall(state, idx), savedDraft };
};

const historyDown = (state: EditorState): EditorState => {
  if (state.historyCursor === null) return state;
  if (state.historyCursor >= state.history.length - 1) {
    const lines = state.savedDraft.split("\n");
    const last = lines.length - 1;
    return {
      ...state,
      lines,
      cursor: { row: last, col: graphemeCount(lines[last]) },
      historyCursor: null,
    };
  }
  return recall(state, state.historyCursor + 1);
};

const submit = (state: EditorState): [EditorState, EditorAction] => {
  const text = state.lines.join("\n");
  const history = text.length > 0 ? [...state.history, text] : state.history;
  return [
    {
      ...state,
      lines: [""],
      cursor: { row: 0, col: 0 },
      history,
      historyCursor: null,
      savedDraft: "",
    },
    { type: "submit", text },
  ];
};

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * Pure editor reducer. Returns `[nextState, action?]`. The action is non-null
 * only on submit. Unknown / no-op events return the state unchanged.
 */
export const editorReducer = (
  state: EditorState,
  ev: InputEvent,
): readonly [EditorState, EditorAction?] => {
  // -- bracketed paste (with >5-line collapse) -----------------------------
  if (ev.kind === "paste") {
    const lineCount = ev.text.split("\n").length;
    if (lineCount > 5) {
      return [insertText(state, `[pasted ${lineCount} lines]`), undefined];
    }
    return [insertText(state, ev.text), undefined];
  }

  if (ev.kind === "esc") return [state, undefined];

  // -- printable text + ctrl-letter commands (kitty + legacy forms) --------
  if (ev.kind === "text") {
    // matchesKey accepts both the kitty "a"+ctrl form and the legacy raw
    // control byte ("\x01" etc.), so the bindings work in any terminal.
    if (matchesKey(ev, "ctrl+a")) return [moveLineStart(state), undefined];
    if (matchesKey(ev, "ctrl+e")) return [moveLineEnd(state), undefined];
    if (matchesKey(ev, "ctrl+u")) return [killToLineStart(state), undefined];
    if (matchesKey(ev, "ctrl+k")) return [killToLineEnd(state), undefined];
    if (matchesKey(ev, "ctrl+w")) return [killWordBack(state), undefined];
    // ctrl+enter and ctrl+m submit too (handy when shift+enter is unavailable).
    if (matchesKey(ev, "ctrl+m")) return submit(state);
    // Remaining ctrl/alt-prefixed text events are shortcut prefixes — swallow
    // so e.g. raw ctrl+c bytes don't get typed into the buffer (the app owns
    // ctrl+c anyway, but be defensive).
    if (ev.mods.ctrl || ev.mods.alt) return [state, undefined];
    return [insertText(state, ev.text), undefined];
  }

  // -- named keys -----------------------------------------------------------
  switch (ev.key) {
    case "enter":
      // shift+enter inserts a newline; plain enter submits.
      if (ev.mods.shift) return [insertText(state, "\n"), undefined];
      return submit(state);
    case "backspace":
      return [deleteBackward(state), undefined];
    case "delete":
      return [deleteForward(state), undefined];
    case "left":
      return [ev.mods.alt ? moveWordLeft(state) : moveLeft(state), undefined];
    case "right":
      return [ev.mods.alt ? moveWordRight(state) : moveRight(state), undefined];
    case "up":
      // multi-line buffer: navigate rows; single-line: recall history.
      return [state.lines.length > 1 ? moveUp(state) : historyUp(state), undefined];
    case "down":
      return [
        state.lines.length > 1 ? moveDown(state) : historyDown(state),
        undefined,
      ];
    case "home":
      return [moveLineStart(state), undefined];
    case "end":
      return [moveLineEnd(state), undefined];
    default:
      return [state, undefined];
  }
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

const span = (text: string, fg: Color, extra: { reverse?: boolean; dim?: boolean } = {}): StyledSpan => ({
  text,
  style: { fg, ...extra },
});

const plain = (text: string): StyledSpan => ({ text, style: {} });

const repeatStr = (s: string, n: number): string => s.repeat(Math.max(0, n));

/**
 * Render the editor as a rounded box. `width` is the full screen width the box
 * may occupy (including borders). The box height adapts to the buffer.
 */
export const renderEditor = (
  state: EditorState,
  width: number,
  focused: boolean,
  theme: EditorTheme,
): StyledLine[] => {
  const boxW = Math.max(4, width);
  const innerW = Math.max(0, boxW - 4); // "│ " + content + " │"
  const borderFg = focused ? theme.accent : theme.border;
  const lines = state.lines.length > 0 ? state.lines : [""];
  const out: StyledLine[] = [];

  // top border
  out.push({
    spans: [
      span(TOP_LEFT + repeatStr(HBAR, boxW - 2) + TOP_RIGHT, borderFg),
    ],
  });

  const empty = editorIsEmpty(state);

  for (let r = 0; r < lines.length; r++) {
    const line = lines[r];
    const isCursorRow = focused && r === state.cursor.row && !empty;
    const spans: StyledSpan[] = [span(`${VBAR} `, borderFg)];

    if (empty && r === 0) {
      const ph = truncateToWidth(state.placeholder, innerW);
      spans.push(span(ph, theme.placeholder, { dim: true }));
      const pad = innerW - stringWidth(ph);
      if (pad > 0) spans.push(plain(repeatStr(" ", pad)));
    } else if (isCursorRow) {
      appendCursorContent(spans, line, state.cursor.col, innerW, theme);
    } else {
      const txt = truncateToWidth(line, innerW);
      spans.push(span(txt, theme.text));
      const pad = innerW - stringWidth(txt);
      if (pad > 0) spans.push(plain(repeatStr(" ", pad)));
    }

    spans.push(span(` ${VBAR}`, borderFg));
    out.push({ spans });
  }

  // bottom border
  out.push({
    spans: [
      span(BOTTOM_LEFT + repeatStr(HBAR, boxW - 2) + BOTTOM_RIGHT, borderFg),
    ],
  });

  return out;
};

/**
 * Append the content spans of one cursor row, stamping the caret's whole
 * grapheme cluster in reverse video. If the caret is beyond the visible inner
 * width, fall back to a plain render (no horizontal scrolling in v1).
 *
 * Cluster granularity matters here: the caret cell is the full cluster (an
 * emoji or a base+combining chain), so reverse video never splits a wide glyph
 * across two cells. `col` is a grapheme-cluster index into `line`.
 */
const appendCursorContent = (
  spans: StyledSpan[],
  line: string,
  col: number,
  innerW: number,
  theme: EditorTheme,
): void => {
  const gs = graphemes(line);
  const before = gs.slice(0, col).join("");
  const beforeW = stringWidth(before);
  if (beforeW >= innerW) {
    const txt = truncateToWidth(line, innerW);
    spans.push(span(txt, theme.text));
    const pad = innerW - stringWidth(txt);
    if (pad > 0) spans.push(plain(repeatStr(" ", pad)));
    return;
  }
  spans.push(span(before, theme.text));
  const cursorCluster = col < gs.length ? gs[col] : " ";
  spans.push(span(cursorCluster, theme.text, { reverse: true }));
  const used = beforeW + Math.max(1, stringWidth(cursorCluster));
  const remain = innerW - used;
  if (remain > 0) {
    const after = gs.slice(col + 1).join("");
    const tAfter = truncateToWidth(after, remain);
    spans.push(span(tAfter, theme.text));
    const pad = remain - stringWidth(tAfter);
    if (pad > 0) spans.push(plain(repeatStr(" ", pad)));
  }
};
