// ===========================================================================
// @niuma/tui — streaming markdown renderer (hand-written tokenizer)
// ---------------------------------------------------------------------------
// Renders a markdown string into tuikit `StyledLine[]` for the transcript.
// The tokenizer is deliberately hand-written (zero deps) and line-oriented
// for block structure, recursive-descent for inline spans:
//
//   block-level:  ATX headings, fenced code blocks, bullet/ordered lists,
//                 blockquotes, thematic breaks, paragraphs (hard-wrapped).
//   inline:       **bold** / __bold__, *italic* / _italic_, `inline code`,
//                 [link](url) -> underlined text + dimmed URL. Backslash
//                 escapes for the active punctuation.
//
// STREAMING (opts.streaming = true):
//   - An unclosed trailing fenced block renders as an OPEN block (no bottom
//     border) — it only ever GROWS as more chunks arrive, never shrinks or
//     flickers (trimPartialClosingFence: a trailing line that looks like a
//     fence-closer-in-progress, i.e. only fence chars but shorter than the
//     opener, is held back rather than rendered as content).
//   - An unclosed trailing bold/italic/inline-code span has no closer, so the
//     inline scanner naturally leaves its opening delimiter as literal text
//     until the matching closer arrives (same behaviour in non-streaming).
//
// Pure function; table-driven tests cover the inline grammar, every block,
// the hard-wrap math, CJK width, and the streaming fence edge cases.
// ===========================================================================

import {
  type StyledLine,
  type StyledSpan,
  type Style,
  stringWidth,
  truncateToWidth,
} from "@niuma/tuikit";
import type { Theme } from "./theme.ts";

// ---------------------------------------------------------------------------
// Options + public entry
// ---------------------------------------------------------------------------

export interface RenderMarkdownOptions {
  /** Target cell width; paragraphs and code blocks wrap/clip to this. */
  readonly width: number;
  /** Streaming mode: unclosed trailing fences/spans render open/literal. */
  readonly streaming: boolean;
  /** Palette the blocks are painted with. */
  readonly theme: Theme;
}

/**
 * Render markdown `text` to styled lines. The output is a flat list of rows
 * (no trailing blank), each already wrapped/clipped to `opts.width`.
 */
export const renderMarkdown = (
  text: string,
  opts: RenderMarkdownOptions,
): StyledLine[] => {
  const width = Math.max(1, opts.width);
  const out: StyledLine[] = [];
  let lines = text.split("\n");
  // Streaming trim: a trailing newline produces a phantom final "" that
  // represents the not-yet-arrived next line. Rendering it would inflate the
  // output by one row that vanishes when real content lands -> flicker. Drop
  // it in streaming mode (non-streaming keeps it; it parses as a blank line).
  if (
    opts.streaming &&
    text.endsWith("\n") &&
    lines.length > 0 &&
    lines[lines.length - 1] === ""
  ) {
    lines = lines.slice(0, -1);
  }

  let i = 0;
  // Active fenced-code-block state (set when a fence opens).
  let fenceChar: "`" | "~" | null = null;
  let fenceCount = 0;
  let fenceLang = "";
  const fenceLines: string[] = [];

  const flushOpenFence = (open: boolean): void => {
    if (fenceChar === null) return;
    // trimPartialClosingFence: in streaming mode an open fence's LAST
    // accumulated line may be a closer-in-progress (only fence chars, shorter
    // than the opener — a full closer would have closed the fence during the
    // scan, so at EOF any fence-char-only line is necessarily partial).
    // Rendering it as content now and re-rendering it as the (invisible)
    // closer next chunk would shrink the block and flicker, so hold it back.
    let renderLines = fenceLines;
    const streamingOpen = opts.streaming && open;
    if (
      streamingOpen &&
      fenceLines.length > 0 &&
      isPartialFenceLine(fenceLines[fenceLines.length - 1], fenceChar)
    ) {
      renderLines = fenceLines.slice(0, -1);
    }
    out.push(...renderCodeBlock(fenceLang, renderLines, width, opts.theme, streamingOpen));
    fenceChar = null;
    fenceCount = 0;
    fenceLang = "";
    fenceLines.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i];

    // -- inside a fenced code block ---------------------------------------
    if (fenceChar !== null) {
      const close = matchFenceClose(line, fenceChar, fenceCount);
      if (close) {
        flushOpenFence(false); // closed cleanly -> closed block
        i++;
        continue;
      }
      fenceLines.push(line);
      i++;
      continue;
    }

    // -- fence open -------------------------------------------------------
    const open = matchFenceOpen(line);
    if (open) {
      fenceChar = open.char;
      fenceCount = open.count;
      fenceLang = open.lang;
      fenceLines.length = 0;
      i++;
      continue;
    }

    // -- blank line -------------------------------------------------------
    if (line.trim().length === 0) {
      i++;
      continue;
    }

    // -- ATX heading ------------------------------------------------------
    const heading = matchHeading(line);
    if (heading) {
      out.push(
        ...wrapSpans(
          tokenizeInline(heading.text, opts.theme, { bold: true, fg: opts.theme.accent }),
          width,
        ),
      );
      i++;
      continue;
    }

    // -- thematic break ---------------------------------------------------
    if (matchThematicBreak(line)) {
      out.push(hrLine(width, opts.theme));
      i++;
      continue;
    }

    // -- blockquote (consecutive > lines fold into one quote) ------------
    if (matchBlockquote(line)) {
      const buf: string[] = [];
      while (i < lines.length) {
        const bq = matchBlockquote(lines[i]);
        if (!bq) break;
        buf.push(bq);
        i++;
      }
      out.push(...renderBlockquote(buf.join("\n"), width, opts.theme));
      continue;
    }

    // -- bullet list item (consecutive items fold into one list) ----------
    const bullet = matchBullet(line);
    if (bullet) {
      const items: Array<{ indent: number; marker: string; text: string }> = [bullet];
      i++;
      while (i < lines.length) {
        const b = matchBullet(lines[i]);
        if (!b) break;
        items.push(b);
        i++;
      }
      out.push(...renderList(items, width, opts.theme));
      continue;
    }

    // -- ordered list item (consecutive items fold into one list) ---------
    const ordered = matchOrdered(line);
    if (ordered) {
      const items: Array<{ indent: number; marker: string; text: string }> = [ordered];
      i++;
      while (i < lines.length) {
        const o = matchOrdered(lines[i]);
        if (!o) break;
        items.push(o);
        i++;
      }
      out.push(...renderList(items, width, opts.theme));
      continue;
    }

    // -- paragraph (accumulate until blank / block boundary) -------------
    const para: string[] = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      if (
        next.trim().length === 0 ||
        matchFenceOpen(next) ||
        matchHeading(next) ||
        matchBullet(next) ||
        matchOrdered(next) ||
        matchBlockquote(next) ||
        matchThematicBreak(next)
      ) {
        break;
      }
      para.push(next);
      i++;
    }
    out.push(
      ...wrapSpans(
        tokenizeInline(para.join(" "), opts.theme, { fg: opts.theme.text }),
        width,
      ),
    );
  }

  // EOF inside an open fence: render it. In streaming mode it stays an OPEN
  // block; in non-streaming it renders closed (markdown treats an unterminated
  // fence as running to EOF).
  if (fenceChar !== null) flushOpenFence(true);

  return out;
};

// ---------------------------------------------------------------------------
// Inline grammar (recursive descent)
// ---------------------------------------------------------------------------
//
// `tokenizeInline(text, theme, base)` scans `text`, emitting spans whose
// style is `base` merged with whatever inline markers wrap them. An opening
// marker with no matching closer before EOF is left as literal text — this is
// what makes unclosed trailing bold/italic/code render literally while
// streaming, with no special-casing.

const tokenizeInline = (
  text: string,
  theme: Theme,
  base: Style,
): StyledSpan[] => {
  const out: StyledSpan[] = [];
  let lit = "";
  const flushLit = (): void => {
    if (lit.length > 0) {
      out.push({ text: lit, style: { ...base } });
      lit = "";
    }
  };

  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);

    // backslash escape: next char is literal
    if (rest[0] === "\\" && rest.length >= 2) {
      lit += rest[1];
      i += 2;
      continue;
    }

    // inline code: `...` (content is opaque to other formatting)
    const code = matchBacktick(rest);
    if (code) {
      flushLit();
      out.push({
        text: code.content,
        style: { ...base, fg: theme.text, bg: theme.codeBg },
      });
      i += code.len;
      continue;
    }

    // link: [text](url)
    const link = matchLink(rest);
    if (link) {
      flushLit();
      out.push({ text: link.text, style: { ...base, underline: true } });
      out.push({
        text: ` (${link.url})`,
        style: { ...base, fg: theme.textDim, dim: true },
      });
      i += link.len;
      continue;
    }

    // bold+italic: ***..*** or ___..___  (check before ** / __ so the
    // three-char run wins over the two-char bold delimiter).
    const boldItalic = matchDelim(rest, "***") ?? matchDelim(rest, "___");
    if (boldItalic) {
      flushLit();
      out.push(
        ...tokenizeInline(boldItalic.content, theme, { ...base, bold: true, italic: true }),
      );
      i += boldItalic.len;
      continue;
    }

    // bold: **..** or __..__
    const bold = matchDelim(rest, "**") ?? matchDelim(rest, "__");
    if (bold) {
      flushLit();
      out.push(...tokenizeInline(bold.content, theme, { ...base, bold: true }));
      i += bold.len;
      continue;
    }

    // italic: *..* or _.._
    const italic = matchDelim(rest, "*") ?? matchDelim(rest, "_");
    if (italic) {
      flushLit();
      out.push(...tokenizeInline(italic.content, theme, { ...base, italic: true }));
      i += italic.len;
      continue;
    }

    // ordinary char
    lit += rest[0];
    i += 1;
  }
  flushLit();
  return out;
};

/** Match a `` `...` `` inline-code span at the start of `rest`. */
const matchBacktick = (
  rest: string,
): { content: string; len: number } | null => {
  if (rest[0] !== "`") return null;
  const end = rest.indexOf("`", 1);
  if (end === -1) return null; // no closer -> literal backtick
  return { content: rest.slice(1, end), len: end + 1 };
};

/**
 * Match a `delim`-wrapped span (e.g. `**`/`__`/`*`/`_`) at the start of
 * `rest`. Returns the inner content and total bytes consumed, or null when
 * there is no matching closer (caller then treats `delim` as literal).
 */
const matchDelim = (
  rest: string,
  delim: string,
): { content: string; len: number } | null => {
  if (!rest.startsWith(delim)) return null;
  const idx = rest.indexOf(delim, delim.length);
  if (idx === -1) return null;
  return { content: rest.slice(delim.length, idx), len: idx + delim.length };
};

/** Match a markdown link `[text](url)` at the start of `rest`. */
const matchLink = (
  rest: string,
): { text: string; url: string; len: number } | null => {
  if (rest[0] !== "[") return null;
  const close = rest.indexOf("]");
  if (close === -1 || rest[close + 1] !== "(") return null;
  // find the matching ')' for the url (urls do not contain ')')
  const urlEnd = rest.indexOf(")", close + 2);
  if (urlEnd === -1) return null;
  const text = rest.slice(1, close);
  const url = rest.slice(close + 2, urlEnd);
  return { text, url, len: urlEnd + 1 };
};

// ---------------------------------------------------------------------------
// Block matchers
// ---------------------------------------------------------------------------

interface FenceOpen {
  readonly char: "`" | "~";
  readonly count: number;
  readonly lang: string;
}

/** An opening fence line: up to 3 leading spaces, 3+ ` or ~, optional lang. */
const matchFenceOpen = (line: string): FenceOpen | null => {
  const m = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
  if (!m) return null;
  const char = (m[2][0] === "`" ? "`" : "~") as "`" | "~";
  return { char, count: m[2].length, lang: m[3].trim() };
};

/** A closing fence line: same char as the opener, count >= opener, else junk. */
const matchFenceClose = (
  line: string,
  openChar: "`" | "~",
  openCount: number,
): boolean => {
  const m = line.match(/^( {0,3})(`{3,}|~{3,})\s*$/);
  if (!m) return false;
  if (m[2][0] !== openChar) return false;
  return m[2].length >= openCount;
};

/** A fence-char-only line (could grow into a closer while streaming). */
const isPartialFenceLine = (line: string, openChar: "`" | "~"): boolean => {
  const m = line.match(/^( {0,3})(`+|~+)\s*$/);
  return m !== null && m[2][0] === openChar;
};

/** ATX heading: 1..6 `#`, a space, then text. */
const matchHeading = (line: string): { level: number; text: string } | null => {
  const m = line.match(/^( {0,3})(#{1,6})(?:\s+(.*?))?\s*#*\s*$/);
  if (!m) return null;
  return { level: m[2].length, text: (m[3] ?? "").trim() };
};

/** Bullet list item: `-`, `*`, or `+` then space. */
const matchBullet = (
  line: string,
): { indent: number; marker: string; text: string } | null => {
  const m = line.match(/^( *)([-*+])\s+(.*)$/);
  if (!m) return null;
  return { indent: m[1].length, marker: `${m[2]} `, text: m[3] };
};

/** Ordered list item: `N.` or `N)` then space. */
const matchOrdered = (
  line: string,
): { indent: number; marker: string; text: string } | null => {
  const m = line.match(/^( *)(\d{1,9})([.)])\s+(.*)$/);
  if (!m) return null;
  return { indent: m[1].length, marker: `${m[2]}${m[3]} `, text: m[4] };
};

/** Blockquote line: `>` optionally followed by a space and content. */
const matchBlockquote = (line: string): string | null => {
  const m = line.match(/^ {0,3}>\s?(.*)$/);
  return m ? m[1] : null;
};

/** Thematic break: 3+ of `-`, `*`, or `_` (optionally space-separated). */
const matchThematicBreak = (line: string): boolean => {
  const m = line.match(/^ {0,3}([-*_])\s*(?:\1\s*){2,}$/);
  return m !== null;
};

// ---------------------------------------------------------------------------
// Block renderers
// ---------------------------------------------------------------------------

const blank = (style: Style = {}): StyledSpan => ({ text: " ", style });

/** A horizontal-rule line: full-width dim dashes. */
const hrLine = (width: number, theme: Theme): StyledLine => ({
  spans: [{ text: "─".repeat(width), style: { fg: theme.border, dim: true } }],
});

/**
 * Render a fenced code block as a rounded box with the language tag in the
 * top border. `open=true` (streaming) omits the bottom border — the block is
 * still receiving content, so it only grows, never flickers.
 *
 * Layout (blockW = width):
 *   ╭─ lang ───────╮
 *   │ <code      > │   <- inner region painted with codeBg
 *   ╰──────────────╯   <- only when closed
 */
const renderCodeBlock = (
  lang: string,
  codeLines: readonly string[],
  width: number,
  theme: Theme,
  open: boolean,
): StyledLine[] => {
  const blockW = Math.max(4, width);
  const codeW = Math.max(1, blockW - 4); // "│ " + code + " │"
  const out: StyledLine[] = [];

  // -- top border with language tag ----------------------------------------
  if (lang.length > 0) {
    // The tag can be longer than the whole block (e.g. a language name wider
    // than `width`): truncate it so the header never exceeds blockW cells.
    const left = "╭─ ";
    const rightCorner = "╮";
    const leftW = stringWidth(left);
    const cornerW = stringWidth(rightCorner);
    let shownLang = truncateToWidth(lang, Math.max(0, blockW - leftW - 1 - cornerW), false);
    let labelW = leftW + stringWidth(shownLang) + 1 + cornerW;
    if (labelW > blockW) {
      // Degenerate narrow block: drop the tag rather than overflow.
      shownLang = "";
      labelW = leftW + cornerW;
    }
    const dashCount = Math.max(0, blockW - labelW);
    const spans: StyledSpan[] = [{ text: left, style: { fg: theme.border } }];
    if (shownLang.length > 0) {
      spans.push(
        { text: shownLang, style: { fg: theme.accent, bold: true } },
        { text: " ", style: { fg: theme.border } },
      );
    }
    spans.push(
      { text: "─".repeat(dashCount), style: { fg: theme.border } },
      { text: rightCorner, style: { fg: theme.border } },
    );
    out.push({ spans });
  } else {
    out.push({
      spans: [
        { text: "╭", style: { fg: theme.border } },
        { text: "─".repeat(blockW - 2), style: { fg: theme.border } },
        { text: "╮", style: { fg: theme.border } },
      ],
    });
  }

  // -- content lines on codeBg ---------------------------------------------
  for (const raw of codeLines) {
    const clipped = truncateToWidth(raw, codeW, false);
    const pad = codeW - stringWidth(clipped);
    out.push({
      spans: [
        { text: "│", style: { fg: theme.border } },
        { text: ` ${clipped}${" ".repeat(Math.max(0, pad))} `, style: { fg: theme.text, bg: theme.codeBg } },
        { text: "│", style: { fg: theme.border } },
      ],
    });
  }

  // -- bottom border (closed blocks only) ----------------------------------
  if (!open) {
    out.push({
      spans: [
        { text: "╰", style: { fg: theme.border } },
        { text: "─".repeat(blockW - 2), style: { fg: theme.border } },
        { text: "╯", style: { fg: theme.border } },
      ],
    });
  }
  return out;
};

/** Render a run of consecutive list items, one hanging-indent block each. */
const renderList = (
  items: readonly { indent: number; marker: string; text: string }[],
  width: number,
  theme: Theme,
): StyledLine[] =>
  items.flatMap((item) => {
    const marker = /^[-*+] $/.test(item.marker) ? "• " : item.marker;
    return renderListItem(marker, item.indent, item.text, width, theme);
  });

/**
 * Render one list item with a coloured marker and a hanging-indent wrap:
 * the first wrapped row sits after the marker, continuation rows align under
 * the item text. One StyledLine PER WRAPPED ROW (an earlier single-line draft
 * concatenated every continuation row into the first line's spans, blowing
 * past the width budget).
 */
const renderListItem = (
  marker: string,
  indent: number,
  text: string,
  width: number,
  theme: Theme,
): StyledLine[] => {
  const lead = " ".repeat(indent);
  const markerSpan: StyledSpan = { text: `${lead}${marker}`, style: { fg: theme.accent } };
  const prefixW = stringWidth(`${lead}${marker}`);
  const contentW = Math.max(1, width - prefixW);
  const wrapped = wrapSpans(
    tokenizeInline(text, theme, { fg: theme.text }),
    contentW,
  );
  const indentSpan: StyledSpan = { text: " ".repeat(prefixW), style: {} };
  return wrapped.map((line, idx) => ({
    spans: idx === 0 ? [markerSpan, ...line.spans] : [indentSpan, ...line.spans],
  }));
};

/** Render a blockquote: a coloured bar prefix, dimmed wrapped content. */
const renderBlockquote = (text: string, width: number, theme: Theme): StyledLine[] => {
  const prefix = "▎ ";
  const prefixW = stringWidth(prefix);
  const contentW = Math.max(1, width - prefixW);
  const quoteText = text.replace(/\n/g, " ");
  const wrapped = wrapSpans(
    tokenizeInline(quoteText, theme, { fg: theme.textDim }),
    contentW,
  );
  const bar: StyledSpan = { text: prefix, style: { fg: theme.border } };
  const indent: StyledSpan = { text: " ".repeat(prefixW), style: {} };
  return wrapped.map((line, idx) => ({
    spans: idx === 0 ? [bar, ...line.spans] : [indent, ...line.spans],
  }));
};

// ---------------------------------------------------------------------------
// Word-wrap (stringWidth-aware)
// ---------------------------------------------------------------------------

/**
 * Greedily wrap a span list to `width` cells at word boundaries. Spaces do
 * not start a new line; a single word wider than the line is hard-split at
 * the cell boundary (prefix-correct via `truncateToWidth`). Style is carried
 * per word so e.g. half a bold phrase still renders bold.
 */
const wrapSpans = (spans: readonly StyledSpan[], width: number): StyledLine[] => {
  const safeWidth = Math.max(1, width);
  const lines: StyledLine[] = [];
  let lineSpans: StyledSpan[] = [];
  let lineW = 0;

  /** Push a single chunk of text (one style), word-breaking as needed. */
  const emit = (chunk: string, style: Style): void => {
    const tokens = chunk.match(/\S+|\s+/g);
    if (!tokens) return;
    for (const tok of tokens) {
      let remaining = tok;
      while (remaining.length > 0) {
        const isSpace = /\s/.test(remaining[0]);
        // Drop a space that would begin a fresh line.
        if (lineSpans.length === 0 && isSpace) {
          remaining = remaining.slice(1);
          continue;
        }
        const tokW = stringWidth(remaining);
        const room = safeWidth - lineW;
        if (tokW <= room) {
          lineSpans.push({ text: remaining, style: { ...style } });
          lineW += tokW;
          remaining = "";
        } else if (lineSpans.length === 0) {
          // Line empty + token too wide for a whole line: hard-split to width.
          const piece = truncateToWidth(remaining, safeWidth, false);
          const pieceW = stringWidth(piece);
          lineSpans.push({ text: piece, style: { ...style } });
          lineW += pieceW;
          lines.push({ spans: lineSpans });
          lineSpans = [];
          lineW = 0;
          remaining = remaining.slice(piece.length);
        } else {
          // Flush the current line, then retry the token on a fresh line.
          lines.push({ spans: lineSpans });
          lineSpans = [];
          lineW = 0;
        }
      }
    }
  };

  for (const s of spans) emit(s.text, s.style);
  if (lineSpans.length > 0) lines.push({ spans: lineSpans });
  if (lines.length === 0) lines.push({ spans: [blank()] });
  return lines;
};

// ---------------------------------------------------------------------------
// Exports for tests / re-use
// ---------------------------------------------------------------------------

/** Inline-only tokenizer, exported for direct unit testing. */
export { tokenizeInline as tokenizeInlineSpans };
