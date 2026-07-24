// ===========================================================================
// @niuma/tui — markdown renderer tests
// ---------------------------------------------------------------------------
// Pure, table-driven. Covers the inline grammar (bold/italic/code/link/
// escape), every block kind (heading / list / blockquote / thematic break /
// fenced code), the stringWidth-aware hard-wrap (incl. CJK), and the
// streaming fence edge cases the interlock calls out:
//   - an unclosed trailing fence renders OPEN (streaming) vs CLOSED (not);
//   - content streaming across chunks never shrinks the rendered output
//     (flicker-free), and the finally-closed block has a bottom border;
//   - trimPartialClosingFence: a trailing closer-in-progress is held back.
// No dylib is needed beyond tuikit width/truncate (which is built).
// ===========================================================================

import {
  assert,
  assertEquals,
  assertFalse,
  assertGreaterOrEqual,
} from "@std/assert";
import type { StyledLine, StyledSpan } from "@niuma/tuikit";
import { stringWidth } from "@niuma/tuikit";
import { renderMarkdown, tokenizeInlineSpans } from "../src/markdown.ts";
import { darkTheme as THEME, type Theme } from "../src/theme.ts";

// Eager-load the native cdylib at module init (not inside a test) so deno's
// leak sanitizer does not attribute the long-lived library to any test.
stringWidth("niuma");

const W = 60;
const render = (text: string, streaming = false): StyledLine[] =>
  renderMarkdown(text, { width: W, streaming, theme: THEME });

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Concatenate every span's text on a line. */
const lineText = (line: StyledLine): string =>
  line.spans.map((s) => s.text).join("");

/** Concatenate every line's text into one string (for substring checks). */
const allText = (lines: readonly StyledLine[]): string =>
  lines.map(lineText).join("\n");

/** Flatten all spans across all lines. */
const allSpans = (lines: readonly StyledLine[]): StyledSpan[] =>
  lines.flatMap((l) => l.spans);

/** True when a span carries a specific style flag (bold/italic/underline/...). */
const hasFlag = (
  span: StyledSpan,
  flag: "bold" | "italic" | "underline" | "dim",
): boolean => span.style[flag] === true;

/** Colour-equality on the (rgb/256/named/default) word form. */
const colorEq = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** True when any span's fg matches the given theme colour. */
const hasFg = (
  lines: readonly StyledLine[],
  themeColor: Theme["text"],
): boolean =>
  allSpans(lines).some((s) =>
    s.style.fg !== undefined && colorEq(s.style.fg, themeColor)
  );

/** Every rendered line is at most `width` display cells (no overflow). */
const assertNoOverflow = (lines: readonly StyledLine[], width = W): void => {
  for (const line of lines) {
    const w = line.spans.reduce((n, s) => n + stringWidth(s.text), 0);
    assertGreaterOrEqual(
      width,
      w,
      `line wider than ${width}: "${lineText(line)}"`,
    );
  }
};

// ===========================================================================
// Inline grammar
// ===========================================================================

Deno.test("markdown: ATX heading is bold + accent", () => {
  const lines = render("# Title");
  assertEquals(lines.length, 1);
  const spans = lines[0].spans;
  assertEquals(
    spans.some((s) => s.text === "Title" && hasFlag(s, "bold")),
    true,
  );
  assertEquals(hasFg(lines, THEME.accent), true);
});

Deno.test("markdown: heading level 2 still single line, bold+accent", () => {
  const lines = render("## Sub");
  assertEquals(lines.length, 1);
  assertEquals(allText(lines), "Sub");
  assertEquals(hasFg(lines, THEME.accent), true);
});

Deno.test("markdown: bold span via **", () => {
  const spans = tokenizeInlineSpans("a **bold** b", THEME, { fg: THEME.text });
  const bold = spans.find((s) => s.text === "bold");
  assertEquals(bold !== undefined && hasFlag(bold, "bold"), true);
  // surrounding text is not bold
  assertEquals(spans.some((s) => s.text === "a " && !hasFlag(s, "bold")), true);
});

Deno.test("markdown: italic span via *", () => {
  const spans = tokenizeInlineSpans("a *ital* b", THEME, { fg: THEME.text });
  const ital = spans.find((s) => s.text === "ital");
  assertEquals(ital !== undefined && hasFlag(ital, "italic"), true);
});

Deno.test("markdown: bold+italic via ***", () => {
  const spans = tokenizeInlineSpans("***both***", THEME, { fg: THEME.text });
  const both = spans.find((s) => s.text === "both");
  assertEquals(
    both !== undefined && hasFlag(both, "bold") && hasFlag(both, "italic"),
    true,
  );
});

Deno.test("markdown: inline code gets codeBg", () => {
  const spans = tokenizeInlineSpans("before `code` after", THEME, {
    fg: THEME.text,
  });
  const code = spans.find((s) => s.text === "code");
  assertEquals(code !== undefined, true);
  assertEquals(
    code!.style.bg !== undefined && colorEq(code!.style.bg, THEME.codeBg),
    true,
  );
});

Deno.test("markdown: link renders underlined text + dimmed url", () => {
  const spans = tokenizeInlineSpans("see [docs](http://x.io) now", THEME, {
    fg: THEME.text,
  });
  assertEquals(
    spans.some((s) => s.text === "docs" && hasFlag(s, "underline")),
    true,
  );
  assertEquals(
    spans.some((s) => s.text === " (http://x.io)" && hasFlag(s, "dim")),
    true,
  );
});

Deno.test("markdown: backslash escapes punctuation literally", () => {
  const spans = tokenizeInlineSpans("a \\*not ital\\* b", THEME, {
    fg: THEME.text,
  });
  // no italic span; the stars survived as literal text
  assertEquals(spans.some((s) => hasFlag(s, "italic")), false);
  assertEquals(spans.some((s) => s.text.includes("*")), true);
});

Deno.test("markdown: unclosed bold renders literally (no bold span)", () => {
  const spans = tokenizeInlineSpans("**unterminated", THEME, {
    fg: THEME.text,
  });
  assertEquals(spans.some((s) => hasFlag(s, "bold")), false);
});

// ===========================================================================
// Blocks
// ===========================================================================

Deno.test("markdown: closed fenced code block has lang tag + borders", () => {
  const lines = render("```js\nfoo()\n```");
  const text = allText(lines);
  // top border carries the language tag in accent
  assertEquals(hasFg(lines, THEME.accent), true);
  // content present
  assertEquals(text.includes("foo()"), true);
  // closed -> has both rounded corners
  assertEquals(text.includes("╭"), true);
  assertEquals(text.includes("╯"), true);
  assertNoOverflow(lines);
});

Deno.test("markdown: bullet list items get accent markers", () => {
  const lines = render("- one\n- two");
  assertEquals(lines.length, 2);
  assertEquals(lineText(lines[0]).startsWith("•"), true);
  assertEquals(lineText(lines[1]).startsWith("•"), true);
  assertEquals(hasFg(lines, THEME.accent), true);
});

Deno.test("markdown: ordered list items keep their numbers", () => {
  const lines = render("1. alpha\n2. beta");
  assertEquals(lines.length, 2);
  assertEquals(lineText(lines[0]).startsWith("1."), true);
  assertEquals(lineText(lines[1]).startsWith("2."), true);
});

Deno.test("markdown: blockquote renders a bar prefix + dimmed text", () => {
  const lines = render("> a quoted line");
  assertEquals(lines.length, 1);
  assertEquals(lineText(lines[0]).startsWith("▎"), true);
  assertEquals(hasFg(lines, THEME.border), true);
});

Deno.test("markdown: thematic break is a full-width dim rule", () => {
  const lines = render("---");
  assertEquals(lines.length, 1);
  const w = lineText(lines[0]);
  assertEquals(stringWidth(w), W);
  // it is entirely dashes
  assertEquals(w.includes("─"), true);
});

Deno.test("markdown: paragraph hard-wraps to width", () => {
  const text = "the quick brown fox jumps over the lazy dog ".repeat(4);
  const lines = render(text);
  assert(lines.length > 1, "expected wrapping");
  assertNoOverflow(lines);
});

Deno.test("markdown: CJK wide chars are wrapped by display width", () => {
  // Each CJK char is width 2; at width=10 we expect several wrapped rows and
  // no row to exceed 10 cells.
  const lines = renderMarkdown("你好世界测试汉字宽度换行".repeat(2), {
    width: 10,
    streaming: false,
    theme: THEME,
  });
  assertNoOverflow(lines, 10);
  assert(lines.length > 1, "expected CJK wrapping");
});

Deno.test("markdown: a long unbreakable word is hard-split", () => {
  const lines = renderMarkdown("abcdefghijklmnopqrstuvwxyz".repeat(4), {
    width: 12,
    streaming: false,
    theme: THEME,
  });
  assertNoOverflow(lines, 12);
  assert(lines.length > 1);
});

Deno.test("markdown: a wrapped list item stays within width (regression)", () => {
  // Regression: renderListItem used to concatenate every wrapped continuation
  // row into the FIRST line's spans, blowing the width budget (a 40-cell
  // render produced a 104-cell line).
  const lines = renderMarkdown(
    "- this is a long list item that will wrap around the forty column boundary for sure yes it will wrap",
    { width: 40, streaming: false, theme: THEME },
  );
  assert(lines.length > 1, "expected the item to wrap onto multiple rows");
  assertNoOverflow(lines, 40);
  // first row carries the marker; continuation rows are hanging-indented
  assertEquals(lineText(lines[0]).startsWith("•"), true);
  assertEquals(lineText(lines[1]).startsWith("  "), true);
});

Deno.test("markdown: code block narrower than the language tag does not overflow (regression)", () => {
  // Regression: the header row emitted the full language tag regardless of
  // block width (an 8-cell block produced a 42-cell header row).
  const lines = renderMarkdown(
    "```superlonglanguagenamethatexceedswidth\nx\n```",
    { width: 8, streaming: false, theme: THEME },
  );
  assertNoOverflow(lines, 8);
});

// ===========================================================================
// Streaming fence edge cases
// ===========================================================================

Deno.test("markdown: streaming — unclosed fence renders OPEN (no bottom border)", () => {
  const lines = render("```ts\nfoo()\n", true);
  const text = allText(lines);
  assertEquals(text.includes("foo()"), true);
  assertEquals(text.includes("╭"), true, "open block still has a top border");
  assertFalse(text.includes("╯"), "open block must NOT have a bottom border");
});

Deno.test("markdown: non-streaming — unclosed fence renders CLOSED", () => {
  const lines = render("```ts\nfoo()\n", false);
  const text = allText(lines);
  assertEquals(text.includes("╯"), true, "non-streaming open-at-EOF closes");
});

Deno.test("markdown: streaming — rendered line count never shrinks across chunks", () => {
  const chunks = ["```ts\n", "const a = 1\n", "const b = 2\n", "```"];
  let acc = "";
  let prev = -1;
  let finalText = "";
  for (const chunk of chunks) {
    acc += chunk;
    const lines = render(acc, true);
    if (prev >= 0) {
      assertGreaterOrEqual(
        lines.length,
        prev,
        `stream shrank: ${prev} -> ${lines.length}`,
      );
    }
    prev = lines.length;
    finalText = allText(lines);
  }
  // The finally-closed block has a bottom border and both content lines.
  assertEquals(finalText.includes("╯"), true);
  assertEquals(finalText.includes("const a = 1"), true);
  assertEquals(finalText.includes("const b = 2"), true);
});

Deno.test("markdown: streaming — content streams then fence closes (one render)", () => {
  // Same content as the chunk test but rendered once, fully closed.
  const lines = render("```ts\nconst a = 1\nconst b = 2\n```", true);
  const text = allText(lines);
  assertEquals(text.includes("const a = 1"), true);
  assertEquals(text.includes("const b = 2"), true);
  assertEquals(text.includes("╭"), true);
  assertEquals(text.includes("╯"), true); // closed -> bottom border
});

Deno.test("markdown: streaming — trimPartialClosingFence holds a trailing `` closer-in-progress", () => {
  // Buffer ends mid-closer ("``"): not a valid closer (needs >=3) so without
  // the trim it would render as a code content line, then vanish when the
  // third backtick arrives -> flicker. The trim holds it back.
  const held = render("```ts\ncode\n``", true);
  const heldText = allText(held);
  assertEquals(heldText.includes("code"), true);
  assertFalse(heldText.includes("╯"), "still open (no closer yet)");
  // The two-backtick partial closer is NOT rendered as content: the only code
  // row carries "code", and there is exactly one content row.
  const codeRows = held.filter((l) => lineText(l).includes("code"));
  assertEquals(codeRows.length, 1);

  // Contrast: non-streaming renders the `` literally as a content line.
  const live = render("```ts\ncode\n``", false);
  assertEquals(allText(live).includes("``"), true);
});

Deno.test("markdown: streaming — unclosed trailing bold is literal text", () => {
  const lines = render("hello **world", true);
  assertEquals(allSpans(lines).some((s) => hasFlag(s, "bold")), false);
  assertEquals(allText(lines).includes("world"), true);
});

// ===========================================================================
// GFM tables
// ===========================================================================

Deno.test("markdown: GFM table renders aligned rows + header rule", () => {
  const lines = render("| a | b |\n| --- | --- |\n| 1 | 2 |\n| 333 | 4 |");
  assertEquals(lines.length, 4); // header + rule + 2 rows
  const rule = lineText(lines[1]);
  assert(rule.includes("┼"), "header rule must contain ┼");
  assert(rule.includes("─"), "header rule must contain ─");
  // Columns align: every line has the same display width.
  const widths = lines.map((l) =>
    l.spans.reduce((n, s) => n + stringWidth(s.text), 0)
  );
  assertEquals(new Set(widths).size, 1, `widths differ: ${widths.join(",")}`);
  assertNoOverflow(lines);
});

Deno.test("markdown: GFM table CJK cells align by display width", () => {
  const lines = render(
    "| 特性 | 状态 |\n| --- | --- |\n| Agent 循环 | ✅ 已完成 |\n| 工具系统 | ✅ 已完成 |",
  );
  const widths = lines.map((l) =>
    l.spans.reduce((n, s) => n + stringWidth(s.text), 0)
  );
  assertEquals(
    new Set(widths).size,
    1,
    `CJK widths differ: ${widths.join(",")}`,
  );
});

Deno.test("markdown: GFM table shrinks columns to fit a narrow viewport", () => {
  const lines = renderMarkdown(
    "| 特性 | 说明 | 状态 |\n| --- | --- | --- |\n| Agent 循环 | 自主感知-推理-行动 | ✅ 已完成 |",
    { width: 30, streaming: false, theme: THEME },
  );
  assertNoOverflow(lines, 30);
  const text = allText(lines);
  assert(text.includes("┼"), "header rule still present when narrow");
});

Deno.test("markdown: table header without a delimiter row renders as a paragraph", () => {
  // A lone pipe row (no `| --- |` next line) is prose, not a table.
  const lines = render("| a | b |\nsome text after");
  const text = allText(lines);
  assert(text.includes("| a | b |"), "raw pipe row kept as paragraph text");
  assertFalse(text.includes("┼"), "no header rule without a delimiter");
});

Deno.test("markdown: streaming — header row before delimiter arrives is not swallowed", () => {
  const partial = render("| a | b |", true);
  assertEquals(allText(partial).includes("| a | b |"), true);
  assertFalse(allText(partial).includes("┼"));
});

Deno.test("markdown: streaming — partial body rows render as they arrive", () => {
  const lines = render("| a | b |\n| --- | --- |\n| 1 | 2 |", true);
  const text = allText(lines);
  assert(
    text.includes("┼"),
    "table with delimiter renders even while streaming",
  );
  assert(text.includes("1"), "first body row present");
});

Deno.test("markdown: short table row is blank-padded to the column count", () => {
  const lines = render("| a | b | c |\n| --- | --- | --- |\n| 1 |");
  const widths = lines.map((l) =>
    l.spans.reduce((n, s) => n + stringWidth(s.text), 0)
  );
  assertEquals(
    new Set(widths).size,
    1,
    `ragged row misaligned: ${widths.join(",")}`,
  );
});

Deno.test("markdown: bold inside a table cell survives as a bold span", () => {
  const lines = render("| a |\n| --- |\n| **x** |");
  assertEquals(
    allSpans(lines).some((s) => hasFlag(s, "bold") && s.text.includes("x")),
    true,
  );
});
