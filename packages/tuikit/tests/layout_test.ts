// ===========================================================================
// @niuma/tuikit — pure layout/viewport/list tests
// ===========================================================================

import { assertEquals } from "@std/assert";
import type { StyledLine } from "../src/binding_contract.ts";
import { renderBlock } from "../src/block.ts";
import {
  alignLine,
  fitLine,
  joinHorizontal,
  lineWidth,
  wrapText,
} from "../src/layout.ts";
import { moveSelection, selectionWindow } from "../src/select_list.ts";
import {
  initialViewport,
  renderViewport,
  updateViewport,
} from "../src/viewport.ts";

const line = (text: string): StyledLine => ({
  spans: [{ text, style: {} }],
});

const textOf = (value: StyledLine): string =>
  value.spans.map((span) => span.text).join("");

Deno.test("layout clips styled spans and pads to an exact width", () => {
  const value: StyledLine = {
    spans: [
      { text: "ab", style: { bold: true } },
      { text: "你好", style: { italic: true } },
      { text: "z", style: {} },
    ],
  };
  const fitted = fitLine(value, 5, true);
  assertEquals(lineWidth(fitted), 5);
  assertEquals(textOf(fitted), "ab你 ");
  assertEquals(fitted.spans[1]?.style.italic, true);
});

Deno.test("layout aligns and joins blocks without changing their height", () => {
  assertEquals(textOf(alignLine(line("x"), 5, "center")), "  x  ");
  const joined = joinHorizontal(
    [[line("a"), line("b")], [line("xy")]],
    { gap: 1, align: "bottom" },
  );
  assertEquals(joined.map(textOf), ["a   ", "b xy"]);
});

Deno.test("block renderer keeps every row at the requested width", () => {
  const block = renderBlock([line("hello")], {
    width: 16,
    title: "niuma",
    paddingX: 1,
    paddingY: 1,
  });
  assertEquals(block.length, 5);
  assertEquals(block.every((row) => lineWidth(row) === 16), true);
  assertEquals(textOf(block[0]!).includes(" niuma "), true);
});

Deno.test("viewport follows the tail and preserves a manual scroll", () => {
  const content = ["a", "b", "c", "d", "e"].map(line);
  let state = initialViewport();
  assertEquals(
    renderViewport(content, state, 4, 3).map((row) => textOf(row).trim()),
    ["c", "d", "e"],
  );

  state = updateViewport(state, { type: "line-up" }, {
    contentHeight: content.length,
    height: 3,
  });
  assertEquals(state, { offset: 1, followTail: false });
  assertEquals(
    renderViewport(content, state, 4, 3).map((row) => textOf(row).trim()),
    ["b", "c", "d"],
  );

  state = updateViewport(state, { type: "content-changed" }, {
    contentHeight: 6,
    height: 3,
  });
  assertEquals(state, { offset: 1, followTail: false });
});

Deno.test("select list wraps and windows around the selected item", () => {
  let state = { selected: 0 };
  state = moveSelection(state, 5, -1);
  assertEquals(state.selected, 4);
  assertEquals(selectionWindow(state, 10, 5), {
    start: 2,
    end: 7,
    selected: 4,
  });
});

Deno.test("layout wrapText preserves wide graphemes and styles", () => {
  const lines = wrapText("你好 world", 4, { bold: true });
  assertEquals(lines.map(textOf), ["你好", "worl", "d"]);
  assertEquals(lines.every((row) => lineWidth(row) <= 4), true);
  assertEquals(lines[0].spans[0].style.bold, true);
});
