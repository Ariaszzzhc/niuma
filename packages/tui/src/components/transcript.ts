// ===========================================================================
// @niuma/tui — transcript (the scrolling conversation view)
// ---------------------------------------------------------------------------
// Composes the per-message renderers into one scrollable column:
//   - user messages:      an accent "❯" prompt + the text (hanging-indent);
//   - assistant messages: renderMarkdown (the live message renders in
//                         streaming mode when opts.streaming is set);
//   - tool messages:      the tool_call card.
//
// `renderTranscript` paints the FULL column, then applies a scroll window of
// `height` rows starting at the effective offset. Window semantics:
//   - followTail pins to the bottom (offset = contentHeight - height);
//   - any scroll up breaks follow (followTail = false);
//   - scrolling back to the bottom re-enables follow.
//
// `transcriptReducer` is the pure update for the scroll messages
// (ScrollUp/Down/PageUp/PageDown/NewContent); it needs the current content
// height + viewport height (passed as `ctx`) to clamp and to detect "back at
// the bottom". `renderTranscriptContent` / `transcriptContentHeight` expose
// the un-windowed column so the app can compute ctx.
// ===========================================================================

import type { StyledLine, StyledSpan } from "@niuma/tuikit";
import { stringWidth, truncateToWidth } from "@niuma/tuikit";
import type { Theme } from "../theme.ts";
import { renderMarkdown } from "../markdown.ts";
import { renderToolCall, type ToolCallView } from "./tool_call.ts";

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** One row of the conversation. */
export type ChatMessage =
  | { readonly role: "user"; readonly text: string }
  | {
    readonly role: "assistant";
    readonly text: string;
    /** Reasoning/thinking text, rendered dimmed above the body. */
    readonly thinking?: string;
  }
  | { readonly role: "tool"; readonly call: ToolCallView };

/** Mutable-by-reduction transcript state. */
export interface TranscriptState {
  readonly messages: readonly ChatMessage[];
  /** Scroll position in rendered lines from the top (authoritative only when
   * `followTail` is false; otherwise render pins to the bottom). */
  readonly scrollOffset: number;
  /** When true, the view stays glued to the newest content. */
  readonly followTail: boolean;
}

/** Reducer messages for transcript scrolling. */
export type TranscriptMsg =
  | { readonly type: "ScrollUp" }
  | { readonly type: "ScrollDown" }
  | { readonly type: "PageUp" }
  | { readonly type: "PageDown" }
  | { readonly type: "NewContent" };

/** Geometry the reducer needs to clamp scroll position. */
export interface TranscriptCtx {
  readonly contentLines: number;
  readonly viewportHeight: number;
}

/** A fresh transcript: empty, following the (nonexistent) tail. */
export const initialTranscript = (): TranscriptState => ({
  messages: [],
  scrollOffset: 0,
  followTail: true,
});

// ---------------------------------------------------------------------------
// Per-message renderers
// ---------------------------------------------------------------------------

/** A full-width blank row (clears stale cells when repainting). */
const blankLine = (width: number): StyledLine => ({
  spans: [{ text: " ".repeat(width), style: {} }],
});

/** Render a user message: "❯ " prompt (accent) + hanging-indent wrapped text. */
const renderUserMessage = (
  text: string,
  width: number,
  theme: Theme,
): StyledLine[] => {
  const prefix = "❯ ";
  const prefixW = stringWidth(prefix);
  const contentW = Math.max(1, width - prefixW);
  const prompt: StyledSpan = {
    text: prefix,
    style: { fg: theme.accent, bold: true },
  };
  const indent: StyledSpan = { text: " ".repeat(prefixW), style: {} };

  // Hard-wrap the user text by display width at word boundaries.
  const wrapped = wrapPlain(text, contentW);
  if (wrapped.length === 0) {
    return [{ spans: [prompt] }];
  }
  return wrapped.map((line, idx) => ({
    spans: idx === 0
      ? [prompt, { text: line, style: { fg: theme.text } }]
      : [indent, { text: line, style: { fg: theme.text } }],
  }));
};

/**
 * Greedy word-wrap of a plain string to `width` cells. Returns the visible
 * text per row (one space kept between words); a single over-wide word is
 * hard-split on cell boundaries via tuikit's prefix-correct truncate.
 */
const wrapPlain = (text: string, width: number): string[] => {
  const safeWidth = Math.max(1, width);
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let cur = "";
  let curW = 0;

  const placeHardSplit = (word: string): void => {
    let rem = word;
    while (rem.length > 0) {
      const rw = stringWidth(rem);
      if (rw <= safeWidth) {
        cur = rem;
        curW = rw;
        rem = "";
      } else {
        const piece = truncateToWidth(rem, safeWidth, false);
        lines.push(piece);
        rem = rem.slice(piece.length);
      }
    }
  };

  for (const word of words) {
    const wordW = stringWidth(word);
    const sepW = cur.length > 0 ? 1 : 0; // one space between words
    if (curW + sepW + wordW <= safeWidth) {
      if (cur.length > 0) {
        cur += " ";
        curW += 1;
      }
      cur += word;
      curW += wordW;
    } else {
      // flush the current line, then lay the word on a fresh line.
      if (cur.length > 0) {
        lines.push(cur);
        cur = "";
        curW = 0;
      }
      placeHardSplit(word);
    }
  }
  if (cur.length > 0) lines.push(cur);
  return lines;
};

// ---------------------------------------------------------------------------
// Full-column render (un-windowed)
// ---------------------------------------------------------------------------

/**
 * Render assistant thinking/reasoning as dimmed, italic lines above the body.
 * Each line carries a "⋮ " gutter prefix (hanging indent on wraps) and the
 * text is word-wrapped into the remaining width; visually de-emphasised
 * (textDim + dim + italic) so it reads as secondary to the answer. Both
 * finalized and still-streaming thinking use this — the model is the same
 * shape either way.
 */
const renderThinking = (
  text: string,
  width: number,
  theme: Theme,
): StyledLine[] => {
  const prefix = "⋮ ";
  const prefixW = stringWidth(prefix);
  const contentW = Math.max(1, width - prefixW);
  const gutter: StyledSpan = {
    text: prefix,
    style: { fg: theme.textDim, dim: true },
  };
  const indent: StyledSpan = { text: " ".repeat(prefixW), style: {} };
  const wrapped = wrapPlain(text, contentW);
  if (wrapped.length === 0) return [{ spans: [gutter] }];
  return wrapped.map((line, idx) => ({
    spans: [
      idx === 0 ? gutter : indent,
      { text: line, style: { fg: theme.textDim, dim: true, italic: true } },
    ],
  }));
};

export interface TranscriptRenderOpts {
  /** Spinner frame forwarded to tool_call cards (animates running tools). */
  readonly spinnerFrame?: number;
  /** When true, the LAST assistant message renders in streaming mode. */
  readonly streaming?: boolean;
}

/**
 * Render the entire transcript column with no windowing. `renderTranscript`
 * uses this and applies the scroll window; the app can call it (or
 * `transcriptContentHeight`) to compute the reducer's `ctx`.
 */
export const renderTranscriptContent = (
  state: TranscriptState,
  width: number,
  theme: Theme,
  opts: TranscriptRenderOpts = {},
): StyledLine[] => {
  const safeWidth = Math.max(1, width);
  const spinnerFrame = opts.spinnerFrame ?? 0;
  const streaming = opts.streaming ?? false;
  const out: StyledLine[] = [];

  for (let m = 0; m < state.messages.length; m++) {
    const msg = state.messages[m];
    const isLast = m === state.messages.length - 1;
    switch (msg.role) {
      case "user":
        out.push(...renderUserMessage(msg.text, safeWidth, theme));
        break;
      case "assistant":
        if (msg.thinking && msg.thinking.length > 0) {
          out.push(...renderThinking(msg.thinking, safeWidth, theme));
        }
        out.push(
          ...renderMarkdown(msg.text, {
            width: safeWidth,
            // Only the trailing assistant message can still be streaming.
            streaming: streaming && isLast,
            theme,
          }),
        );
        break;
      case "tool":
        out.push(...renderToolCall(msg.call, safeWidth, theme, spinnerFrame));
        break;
    }
    // One blank row between top-level messages for breathing room.
    if (m < state.messages.length - 1) out.push(blankLine(safeWidth));
  }
  return out;
};

/** Number of rendered lines in the full column at this width. */
export const transcriptContentHeight = (
  state: TranscriptState,
  width: number,
  theme: Theme,
  opts?: TranscriptRenderOpts,
): number => renderTranscriptContent(state, width, theme, opts).length;

// ---------------------------------------------------------------------------
// Windowed render
// ---------------------------------------------------------------------------

/**
 * Render the visible window of the transcript. Resolves the effective offset
 * from `followTail` (pins to bottom) vs `scrollOffset` (clamped), slices the
 * pre-rendered column, and pads to exactly `height` rows.
 */
export const renderTranscript = (
  state: TranscriptState,
  width: number,
  height: number,
  theme: Theme,
  opts: TranscriptRenderOpts = {},
): StyledLine[] => {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(0, height);
  const content = renderTranscriptContent(state, safeWidth, theme, opts);

  const maxOffset = Math.max(0, content.length - safeHeight);
  const offset = state.followTail
    ? maxOffset
    : Math.min(Math.max(0, state.scrollOffset), maxOffset);

  const window = content.slice(offset, offset + safeHeight);
  while (window.length < safeHeight) window.push(blankLine(safeWidth));
  // The slice is a copy of the region for the first `height` entries; if the
  // content was shorter we appended blanks, so trim any accidental overage.
  if (window.length > safeHeight) window.length = safeHeight;
  return window;
};

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * Pure scroll reducer. `ctx` carries the current content height + viewport
 * height so offsets can be clamped and "scrolled back to bottom" can be
 * detected. When omitted (base 2-arg call) scroll commands degrade to
 * follow/no-op-safe transitions without clamping numbers.
 */
export const transcriptReducer = (
  state: TranscriptState,
  msg: TranscriptMsg,
  ctx: TranscriptCtx = { contentLines: 0, viewportHeight: 0 },
): TranscriptState => {
  const maxOffset = Math.max(0, ctx.contentLines - ctx.viewportHeight);
  // Effective current offset: pinned to bottom when following.
  const cur = state.followTail ? maxOffset : state.scrollOffset;

  switch (msg.type) {
    case "ScrollUp":
      return {
        ...state,
        followTail: false,
        scrollOffset: Math.max(0, cur - 1),
      };
    case "PageUp":
      return {
        ...state,
        followTail: false,
        scrollOffset: Math.max(0, cur - Math.max(1, ctx.viewportHeight)),
      };
    case "ScrollDown": {
      const next = Math.min(maxOffset, cur + 1);
      return { ...state, scrollOffset: next, followTail: next >= maxOffset };
    }
    case "PageDown": {
      const next = Math.min(maxOffset, cur + Math.max(1, ctx.viewportHeight));
      return { ...state, scrollOffset: next, followTail: next >= maxOffset };
    }
    case "NewContent":
      // followTail pins to the newest content at render time; when not
      // following we leave the offset alone so the user's view stays put.
      return state;
  }
};
