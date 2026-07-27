// ===========================================================================
// @niuma/tuikit — styled-line layout primitives
// ---------------------------------------------------------------------------
// Small, allocation-friendly helpers for composing Niuma's full-screen view.
// They deliberately operate on StyledLine[] rather than introducing a second
// component tree. Every helper clips at grapheme boundaries and can pad to an
// exact cell width, keeping Frame writes deterministic after resize.
// ===========================================================================

import type { Style, StyledLine, StyledSpan } from "./binding_contract.ts";
import { stringWidth, truncateToWidth } from "./width.ts";

export interface Size {
  readonly width: number;
  readonly height: number;
}

export type VerticalAlign = "top" | "center" | "bottom";
export type HorizontalAlign = "left" | "center" | "right";

const EMPTY_STYLE: Style = {};

export const lineWidth = (line: StyledLine): number =>
  line.spans.reduce((total, span) => total + stringWidth(span.text), 0);

export const blankLine = (
  width: number,
  style: Style = EMPTY_STYLE,
): StyledLine => ({
  spans: [{ text: " ".repeat(Math.max(0, width)), style }],
});

/**
 * Clip a line to `width` cells and optionally pad it to exactly that width.
 * A span straddling the boundary is truncated without splitting a grapheme.
 */
export const fitLine = (
  line: StyledLine,
  width: number,
  pad = false,
): StyledLine => {
  const budget = Math.max(0, width);
  const spans: StyledSpan[] = [];
  let used = 0;

  for (const span of line.spans) {
    if (used >= budget) break;
    const remaining = budget - used;
    const spanWidth = stringWidth(span.text);
    if (spanWidth <= remaining) {
      if (span.text.length > 0) spans.push(span);
      used += spanWidth;
      continue;
    }
    const text = truncateToWidth(span.text, remaining);
    if (text.length > 0) {
      spans.push({ text, style: span.style });
      used += stringWidth(text);
    }
    break;
  }

  if (pad && used < budget) {
    spans.push({ text: " ".repeat(budget - used), style: EMPTY_STYLE });
  }
  return { spans };
};

/**
 * Greedily wrap a styled line at whitespace boundaries. A token wider than
 * the available row is hard-split at a grapheme boundary. Leading whitespace
 * on a newly wrapped row is discarded.
 */
export const wrapLine = (
  line: StyledLine,
  width: number,
): StyledLine[] => {
  const budget = Math.max(1, width);
  const lines: StyledLine[] = [];
  let spans: StyledSpan[] = [];
  let used = 0;

  const flush = (): void => {
    lines.push({ spans });
    spans = [];
    used = 0;
  };

  const emit = (text: string, style: Style): void => {
    const tokens = text.match(/\S+|\s+/gu);
    if (tokens === null) return;
    for (const token of tokens) {
      let remaining = token;
      while (remaining.length > 0) {
        const whitespace = /^\s/u.test(remaining);
        if (spans.length === 0 && whitespace) {
          remaining = remaining.slice(1);
          continue;
        }
        const tokenWidth = stringWidth(remaining);
        const room = budget - used;
        if (tokenWidth <= room) {
          spans.push({ text: remaining, style });
          used += tokenWidth;
          remaining = "";
        } else if (spans.length === 0) {
          const piece = truncateToWidth(remaining, budget);
          // A zero-width cluster must not leave this loop stuck.
          if (piece.length === 0) {
            remaining = remaining.slice(1);
            continue;
          }
          spans.push({ text: piece, style });
          used += stringWidth(piece);
          remaining = remaining.slice(piece.length);
          flush();
        } else {
          flush();
        }
      }
    }
  };

  for (const span of line.spans) emit(span.text, span.style);
  if (spans.length > 0 || lines.length === 0) lines.push({ spans });
  return lines;
};

export const wrapText = (
  text: string,
  width: number,
  style: Style = EMPTY_STYLE,
): StyledLine[] =>
  text.split("\n").flatMap((logical) =>
    wrapLine({ spans: [{ text: logical, style }] }, width)
  );

export const measureLines = (lines: readonly StyledLine[]): Size => ({
  width: lines.reduce((max, line) => Math.max(max, lineWidth(line)), 0),
  height: lines.length,
});

export const cropLines = (
  lines: readonly StyledLine[],
  width: number,
  height: number,
): StyledLine[] => {
  const safeHeight = Math.max(0, height);
  return lines.slice(0, safeHeight).map((line) => fitLine(line, width));
};

export interface Padding {
  readonly top?: number;
  readonly right?: number;
  readonly bottom?: number;
  readonly left?: number;
}

export const padLines = (
  lines: readonly StyledLine[],
  padding: Padding,
  width?: number,
): StyledLine[] => {
  const top = Math.max(0, padding.top ?? 0);
  const right = Math.max(0, padding.right ?? 0);
  const bottom = Math.max(0, padding.bottom ?? 0);
  const left = Math.max(0, padding.left ?? 0);
  const measured = measureLines(lines).width;
  const outerWidth = Math.max(
    left + right,
    width ?? measured + left + right,
  );
  const innerWidth = Math.max(0, outerWidth - left - right);
  const out: StyledLine[] = [];
  for (let i = 0; i < top; i++) out.push(blankLine(outerWidth));
  for (const line of lines) {
    out.push({
      spans: [
        { text: " ".repeat(left), style: EMPTY_STYLE },
        ...fitLine(line, innerWidth, true).spans,
        { text: " ".repeat(right), style: EMPTY_STYLE },
      ],
    });
  }
  for (let i = 0; i < bottom; i++) out.push(blankLine(outerWidth));
  return out;
};

export const joinVertical = (
  ...blocks: ReadonlyArray<readonly StyledLine[]>
): StyledLine[] => blocks.flatMap((block) => block);

const topFor = (
  height: number,
  blockHeight: number,
  align: VerticalAlign,
): number => {
  const spare = Math.max(0, height - blockHeight);
  if (align === "bottom") return spare;
  if (align === "center") return Math.floor(spare / 2);
  return 0;
};

export const joinHorizontal = (
  blocks: ReadonlyArray<readonly StyledLine[]>,
  options: { readonly gap?: number; readonly align?: VerticalAlign } = {},
): StyledLine[] => {
  if (blocks.length === 0) return [];
  const gap = Math.max(0, options.gap ?? 0);
  const align = options.align ?? "top";
  const sizes = blocks.map(measureLines);
  const height = sizes.reduce((max, size) => Math.max(max, size.height), 0);
  const out: StyledLine[] = [];

  for (let row = 0; row < height; row++) {
    const spans: StyledSpan[] = [];
    for (let i = 0; i < blocks.length; i++) {
      if (i > 0 && gap > 0) {
        spans.push({ text: " ".repeat(gap), style: EMPTY_STYLE });
      }
      const block = blocks[i]!;
      const size = sizes[i]!;
      const sourceRow = row - topFor(height, size.height, align);
      if (sourceRow >= 0 && sourceRow < block.length) {
        spans.push(...fitLine(block[sourceRow]!, size.width, true).spans);
      } else {
        spans.push(...blankLine(size.width).spans);
      }
    }
    out.push({ spans });
  }
  return out;
};

export const alignLine = (
  line: StyledLine,
  width: number,
  align: HorizontalAlign,
): StyledLine => {
  const safeWidth = Math.max(0, width);
  const clipped = fitLine(line, safeWidth);
  const contentWidth = lineWidth(clipped);
  const spare = Math.max(0, safeWidth - contentWidth);
  const left = align === "right"
    ? spare
    : align === "center"
    ? Math.floor(spare / 2)
    : 0;
  const right = spare - left;
  return {
    spans: [
      { text: " ".repeat(left), style: EMPTY_STYLE },
      ...clipped.spans,
      { text: " ".repeat(right), style: EMPTY_STYLE },
    ],
  };
};
