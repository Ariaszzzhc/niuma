// ===========================================================================
// @niuma/tui — command palette reducer/render tests
// ===========================================================================

import { assertEquals } from "@std/assert";
import type { InputEvent, KeyMods } from "@niuma/tuikit";
import { stringWidth } from "@niuma/tuikit";
import {
  openPalette,
  type PaletteItem,
  paletteReducer,
  renderPalette,
} from "../src/components/palette.ts";

stringWidth("niuma");

const mods: KeyMods = {
  shift: false,
  alt: false,
  ctrl: false,
  super: false,
};
const text = (value: string): InputEvent => ({
  kind: "text",
  text: value,
  mods,
  eventType: "press",
});
const backspace: InputEvent = {
  kind: "key",
  key: "backspace",
  mods,
  eventType: "press",
};

const items: readonly PaletteItem[] = [
  { name: "/help", description: "Show help", builtin: true },
  { name: "/model", description: "Select model", builtin: true },
];

Deno.test("palette caret edits whole grapheme clusters", () => {
  let state = openPalette({
    open: false,
    query: "",
    caret: 0,
    selected: 0,
  });
  [state] = paletteReducer(state, text("a👨‍👩‍👧"), items);
  assertEquals(state.caret, 2);
  [state] = paletteReducer(state, backspace, items);
  assertEquals(state.query, "a");
  assertEquals(state.caret, 1);
});

Deno.test("palette renders as a full-width bottom surface with cursor", () => {
  let state = openPalette({
    open: false,
    query: "",
    caret: 0,
    selected: 0,
  });
  [state] = paletteReducer(state, text("h"), items);
  const surface = renderPalette(state, items, 32, {
    border: "default",
    accent: "default",
    text: "default",
    muted: "default",
    prompt: "default",
  });
  assertEquals(
    surface.lines.every((line) =>
      line.spans.reduce((n, span) => n + stringWidth(span.text), 0) === 32
    ),
    true,
  );
  assertEquals(surface.cursor, { row: 1, col: 5, shape: "bar" });
});
