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
import {
  isReadTool,
  renderReadToolGroup,
  renderToolCall,
  type ToolCallView,
} from "./tool_call.ts";
import { SPINNER_FRAMES, THINKING_MARKER, USER_MARKER } from "../symbols.ts";

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
    /** Reveal the complete reasoning block (ctrl+o, recent turns only). */
    readonly detailsExpanded?: boolean;
  }
  | { readonly role: "tool"; readonly call: ToolCallView }
  /** Local command output / system notices (/help, /model, errors…).
   * `kind` mirrors reduce_event's NoticeKind; only "error" gets a distinct
   * colour, the rest render dim. */
  | { readonly role: "notice"; readonly text: string; readonly kind?: string };

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

// ---------------------------------------------------------------------------
// Gutter layout
// ---------------------------------------------------------------------------
//
// The transcript uses a gutter-anchored layout (the user's `❯` is the only
// full-width anchor; everything the assistant produces is indented under it):
//
//   ❯ user question                         <- flush left, accent prompt
//     assistant markdown body               <- GUTTER_INDENT cells in
//     ● tool_call  src/main.ts  120ms       <- bar + indent (tool_call.ts)
//     ⋮ dim italic thinking                 <- GUTTER_INDENT cells in
//
// Assistant/tool content is rendered at `width - GUTTER_INDENT - RIGHT_MARGIN`
// and each row is prefixed with a GUTTER_INDENT-wide blank span. The trailing
// RIGHT_MARGIN keeps text off the right screen edge, so lines never touch
// either border of the terminal.

/** Left indent (cells) for assistant + tool content. */
export const GUTTER_INDENT = 2;
/** Right margin (cells) kept clear for every content row. */
export const RIGHT_MARGIN = 2;

/** Prefix every row with a GUTTER_INDENT-wide blank span (left indent). */
const indentLines = (lines: readonly StyledLine[]): StyledLine[] =>
  lines.map((line) => ({
    spans: [{ text: " ".repeat(GUTTER_INDENT), style: {} }, ...line.spans],
  }));

/** Render a user message: "❯ " prompt (accent) + hanging-indent wrapped text. */
const renderUserMessage = (
  text: string,
  width: number,
  theme: Theme,
): StyledLine[] => {
  const prefix = `${USER_MARKER} `;
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
  options: {
    readonly streaming: boolean;
    readonly expanded: boolean;
    readonly spinnerFrame: number;
  },
): StyledLine[] => {
  const prefix = `${THINKING_MARKER} `;
  const prefixW = stringWidth(prefix);
  const contentW = Math.max(1, width - prefixW);
  const gutter: StyledSpan = {
    text: prefix,
    style: { fg: theme.textDim, dim: true },
  };
  const indent: StyledSpan = { text: " ".repeat(prefixW), style: {} };
  const wrapped = wrapPlain(text, contentW);
  if (wrapped.length === 0) return [{ spans: [gutter] }];
  const body = (lines: readonly string[]): StyledLine[] =>
    lines.map((line, idx) => ({
      spans: [
        idx === 0 ? gutter : indent,
        {
          text: line,
          style: { fg: theme.textDim, dim: true, italic: true },
        },
      ],
    }));

  if (options.streaming) {
    const spinner =
      SPINNER_FRAMES[options.spinnerFrame % SPINNER_FRAMES.length] ??
        SPINNER_FRAMES[0];
    return [
      {
        spans: [
          { text: `${spinner} `, style: { fg: theme.accent } },
          {
            text: "Thinking",
            style: { fg: theme.textDim, dim: true, italic: true },
          },
        ],
      },
      ...body(wrapped.slice(-2)),
    ];
  }

  if (options.expanded || wrapped.length <= 2) return body(wrapped);

  const hidden = wrapped.length - 2;
  return [
    ...body(wrapped.slice(0, 2)),
    {
      spans: [
        indent,
        {
          text: truncateToWidth(
            `ctrl+o to expand · ${hidden} more line${hidden === 1 ? "" : "s"}`,
            contentW,
          ),
          style: { fg: theme.textMuted, dim: true },
        },
      ],
    },
  ];
};

/**
 * Render a system notice (local command output, errors) as dimmed lines with
 * a "─ " gutter. Newlines are preserved (help/list output is pre-formatted);
 * each logical line is word-wrapped. `kind === "error"` uses the error
 * colour instead of the dim one.
 */
const renderNotice = (
  text: string,
  width: number,
  theme: Theme,
  kind?: string,
): StyledLine[] => {
  const prefix = "─ ";
  const prefixW = stringWidth(prefix);
  const contentW = Math.max(1, width - prefixW);
  const fg = kind === "error" ? theme.error : theme.textDim;
  const gutter: StyledSpan = {
    text: prefix,
    style: { fg, dim: kind !== "error" },
  };
  const indent: StyledSpan = { text: " ".repeat(prefixW), style: {} };
  const out: StyledLine[] = [];
  const logical = text.split("\n");
  if (logical.every((l) => l.trim() === "")) return [{ spans: [gutter] }];
  for (const line of logical) {
    const wrapped = wrapPlain(line, contentW);
    if (wrapped.length === 0) {
      out.push({ spans: [gutter] });
      continue;
    }
    for (let idx = 0; idx < wrapped.length; idx++) {
      out.push({
        spans: [
          out.length === 0 ? gutter : indent,
          { text: wrapped[idx], style: { fg, dim: kind !== "error" } },
        ],
      });
    }
  }
  return out;
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
  // Assistant + tool rows render narrower and get re-indented; user rows own
  // the full width (their "❯ " prefix is the gutter anchor).
  const contentW = Math.max(1, safeWidth - GUTTER_INDENT - RIGHT_MARGIN);
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
          out.push(
            ...indentLines(
              renderThinking(msg.thinking, contentW, theme, {
                streaming: streaming && isLast,
                expanded: msg.detailsExpanded === true,
                spinnerFrame,
              }),
            ),
          );
        }
        if (msg.text.length > 0) {
          // Thinking and the visible answer are two visual blocks even though
          // they share one assistant event. Give their internal transition the
          // same single-row rhythm used between top-level transcript items.
          if (msg.thinking && msg.thinking.length > 0) {
            out.push(blankLine(safeWidth));
          }
          out.push(
            ...indentLines(
              renderMarkdown(msg.text, {
                width: contentW,
                // Only the trailing assistant message can still be streaming.
                streaming: streaming && isLast,
                theme,
              }),
            ),
          );
        }
        break;
      case "tool":
        if (isReadTool(msg.call)) {
          const group = [msg.call];
          let nextIndex = m + 1;
          while (nextIndex < state.messages.length) {
            const next = state.messages[nextIndex];
            if (
              next.role !== "tool" ||
              !isReadTool(next.call) ||
              next.call.batchId !== msg.call.batchId
            ) break;
            group.push(next.call);
            nextIndex++;
          }
          if (group.length > 1) {
            out.push(
              ...indentLines(
                renderReadToolGroup(group, contentW, theme, spinnerFrame),
              ),
            );
            m = nextIndex - 1;
          } else {
            out.push(
              ...indentLines(
                renderToolCall(msg.call, contentW, theme, spinnerFrame),
              ),
            );
          }
        } else {
          out.push(
            ...indentLines(
              renderToolCall(msg.call, contentW, theme, spinnerFrame),
            ),
          );
        }
        break;
      case "notice":
        out.push(
          ...indentLines(renderNotice(msg.text, contentW, theme, msg.kind)),
        );
        break;
    }
    // Consecutive tool calls form a compact execution batch. Other top-level
    // transitions keep one row of breathing room.
    if (m < state.messages.length - 1) {
      const next = state.messages[m + 1];
      if (!(msg.role === "tool" && next.role === "tool")) {
        out.push(blankLine(safeWidth));
      }
    }
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
