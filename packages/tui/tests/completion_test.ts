// ===========================================================================
// @niuma/tui — completion menu component tests (pure)
// ---------------------------------------------------------------------------
// Covers the selection movement (wrap-around) and the renderer's width
// discipline (no row ever exceeds the box / screen width, long lists are
// windowed around the selection). No terminal, no app wiring.
// ===========================================================================

import { assertEquals } from "@std/assert";
import { stringWidth } from "@niuma/tuikit";
import {
  initialCompletionState,
  moveCompletion,
  renderCompletionMenu,
} from "../src/components/completion.ts";
import type { CompletionCandidate } from "../src/commands.ts";

// Warm the native lib at module load (stringWidth in the renderer) so leak
// detection doesn't flag a mid-test dlopen — same pattern as app_test.ts.
stringWidth("niuma");

const item = (name: string, description?: string): CompletionCandidate => ({
  name,
  ...(description !== undefined ? { description } : {}),
  builtin: true,
});

const THEME = {
  border: "default",
  accent: "default",
  text: "default",
  muted: "default",
} as const;

Deno.test("moveCompletion wraps around both ends", () => {
  let s = initialCompletionState;
  s = moveCompletion(s, 3, 1);
  assertEquals(s.selected, 1);
  s = moveCompletion(s, 3, 1);
  assertEquals(s.selected, 2);
  s = moveCompletion(s, 3, 1);
  assertEquals(s.selected, 0, "down past the last wraps to 0");
  s = moveCompletion(s, 3, -1);
  assertEquals(s.selected, 2, "up from 0 wraps to the last");
  // empty list is a no-op
  assertEquals(moveCompletion(s, 0, 1).selected, 2);
});

Deno.test("renderCompletionMenu never exceeds the screen width", () => {
  const items = [
    item("compact", "Compact the conversation context"),
    item("a-very-long-command-name", "and an equally very long description"),
    item("mcp"),
  ];
  for (const w of [20, 30, 60]) {
    const lines = renderCompletionMenu(items, 0, w, THEME);
    assertEquals(lines.length, items.length + 2, `w=${w}: border + rows`);
    for (const l of lines) {
      const width = l.spans.reduce((n, s) => n + stringWidth(s.text), 0);
      assertEquals(width <= w, true, `w=${w}: row fits (${width})`);
    }
  }
});

Deno.test("renderCompletionMenu windows long lists around the selection", () => {
  const items = Array.from({ length: 20 }, (_, i) => item(`cmd${i}`));
  const lines = renderCompletionMenu(items, 15, 40, THEME);
  assertEquals(lines.length, 8 + 2, "capped at MAX_VISIBLE rows + borders");
  // the selected row is inside the window (rendered reversed in accent)
  const texts = lines.map((l) => l.spans.map((s) => s.text).join(""));
  assertEquals(
    texts.some((t) => t.includes("/cmd15")),
    true,
    "selection visible in the window",
  );
});

Deno.test("renderCompletionMenu renders nothing for an empty candidate list", () => {
  assertEquals(renderCompletionMenu([], 0, 40, THEME), []);
});
