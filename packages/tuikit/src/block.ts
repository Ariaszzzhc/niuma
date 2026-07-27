// ===========================================================================
// @niuma/tuikit — bordered block renderer
// ---------------------------------------------------------------------------
// Shared chrome for the Niuma editor, completion list and interaction panels.
// It covers only the border/padding variants the product uses; this is not a
// general Lip Gloss clone.
// ===========================================================================

import type {
  Color,
  Style,
  StyledLine,
  StyledSpan,
} from "./binding_contract.ts";
import { fitLine } from "./layout.ts";
import { stringWidth, truncateToWidth } from "./width.ts";

export interface Border {
  readonly topLeft: string;
  readonly top: string;
  readonly topRight: string;
  readonly right: string;
  readonly bottomRight: string;
  readonly bottom: string;
  readonly bottomLeft: string;
  readonly left: string;
}

export const ROUNDED_BORDER: Border = {
  topLeft: "╭",
  top: "─",
  topRight: "╮",
  right: "│",
  bottomRight: "╯",
  bottom: "─",
  bottomLeft: "╰",
  left: "│",
};

export const LINE_BORDER: Border = {
  topLeft: "",
  top: "─",
  topRight: "",
  right: "",
  bottomRight: "",
  bottom: "─",
  bottomLeft: "",
  left: "",
};

export interface BlockOptions {
  readonly width: number;
  readonly border?: Border;
  readonly borderColor?: Color;
  readonly title?: string;
  readonly titleStyle?: Style;
  readonly paddingX?: number;
  readonly paddingY?: number;
}

const span = (text: string, style: Style): StyledSpan => ({ text, style });

const fill = (glyph: string, width: number): string => {
  if (width <= 0 || glyph.length === 0) return "";
  return glyph.repeat(width);
};

const borderLine = (
  left: string,
  fillGlyph: string,
  right: string,
  width: number,
  style: Style,
  title?: string,
  titleStyle?: Style,
): StyledLine => {
  const inner = Math.max(0, width - stringWidth(left) - stringWidth(right));
  if (title === undefined || title.length === 0) {
    return {
      spans: [
        span(left, style),
        span(fill(fillGlyph, inner), style),
        span(right, style),
      ],
    };
  }
  const shown = truncateToWidth(` ${title} `, inner);
  const remaining = Math.max(0, inner - stringWidth(shown));
  return {
    spans: [
      span(left, style),
      span(shown, titleStyle ?? style),
      span(fill(fillGlyph, remaining), style),
      span(right, style),
    ],
  };
};

export const renderBlock = (
  content: readonly StyledLine[],
  options: BlockOptions,
): StyledLine[] => {
  const width = Math.max(1, options.width);
  const border = options.border ?? ROUNDED_BORDER;
  const borderStyle: Style = options.borderColor === undefined
    ? {}
    : { fg: options.borderColor };
  const paddingX = Math.max(0, options.paddingX ?? 1);
  const paddingY = Math.max(0, options.paddingY ?? 0);
  const leftWidth = stringWidth(border.left);
  const rightWidth = stringWidth(border.right);
  const innerWidth = Math.max(
    0,
    width - leftWidth - rightWidth - paddingX * 2,
  );
  const out: StyledLine[] = [
    borderLine(
      border.topLeft,
      border.top,
      border.topRight,
      width,
      borderStyle,
      options.title,
      options.titleStyle,
    ),
  ];

  const bodyLine = (line: StyledLine): StyledLine => ({
    spans: [
      span(border.left, borderStyle),
      span(" ".repeat(paddingX), {}),
      ...fitLine(line, innerWidth, true).spans,
      span(" ".repeat(paddingX), {}),
      span(border.right, borderStyle),
    ],
  });
  const empty = bodyLine({ spans: [] });
  for (let i = 0; i < paddingY; i++) out.push(empty);
  for (const line of content) out.push(bodyLine(line));
  for (let i = 0; i < paddingY; i++) out.push(empty);
  out.push(
    borderLine(
      border.bottomLeft,
      border.bottom,
      border.bottomRight,
      width,
      borderStyle,
    ),
  );
  return out;
};
