// ===========================================================================
// @niuma/tui — component render tests
// ---------------------------------------------------------------------------
// Pure tests for the display components:
//   - transcript: scroll-window math, followTail pin, scroll-up breaks
//     follow, scroll-to-bottom re-enables, page up/down, NewContent,
//     blank padding when content < viewport, user-message prompt;
//   - tool-call: collapsed status glyphs (spinner/done/error), name+summary,
//     expanded tree indent ("⎿ " first / "  " rest), 8-line cap + footer,
//     duration formatting;
//   - statusline: exact width fit at several widths, gradient activity
//     cluster, token compact formatting;
//   - approval modal: header label truncation at narrow widths.
// Only tuikit width/gradient (built) is required.
// ===========================================================================

import { assert, assertEquals, assertFalse, assertGreaterOrEqual } from "jsr:@std/assert@^1.0.0";
import type { StyledLine, StyledSpan } from "@niuma/tuikit";
import { stringWidth } from "@niuma/tuikit";
import { darkTheme as THEME } from "../src/theme.ts";
import { renderToolCall, type ToolCallView } from "../src/components/tool-call.ts";
import { renderStatusline, type StatusView } from "../src/components/statusline.ts";
import { renderApprovalOverlay, type ApprovalTheme } from "../src/components/approval.ts";
import {
  initialTranscript,
  renderTranscript,
  renderTranscriptContent,
  transcriptContentHeight,
  transcriptReducer,
  type ChatMessage,
  type TranscriptState,
} from "../src/components/transcript.ts";

// Eager-load the native cdylib at module init (not inside a test) so deno's
// leak sanitizer does not attribute the long-lived library to any test.
stringWidth("niuma");

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const lineText = (line: StyledLine): string => line.spans.map((s) => s.text).join("");
const lineWidth = (line: StyledLine): number =>
  line.spans.reduce((n, s) => n + stringWidth(s.text), 0);
const allText = (lines: readonly StyledLine[]): string => lines.map(lineText).join("\n");
const colorEq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const hasFg = (lines: readonly StyledLine[], c: unknown): boolean =>
  lines.flatMap((l) => l.spans).some((s) => s.style.fg !== undefined && colorEq(s.style.fg, c));

/** Build a transcript of N short assistant paragraphs (a, b, c, ...). */
const alphaTranscript = (n: number): readonly ChatMessage[] => {
  const letters = "abcdefghijklmnop".slice(0, n).split("");
  const text = letters.join("\n\n"); // blank-separated -> one paragraph each
  return [{ role: "assistant" as const, text }];
};

// ===========================================================================
// transcript — scroll window math
// ===========================================================================

Deno.test("transcript: followTail pins to the bottom", () => {
  const state: TranscriptState = {
    messages: alphaTranscript(8),
    scrollOffset: 0,
    followTail: true,
  };
  const lines = renderTranscript(state, 40, 3, THEME);
  assertEquals(lines.length, 3);
  const texts = lines.map(lineText);
  assertEquals(texts.includes("f"), true); // last 3 are f,g,h
  assertEquals(texts.includes("h"), true);
  assertEquals(texts.includes("a"), false);
});

Deno.test("transcript: content shorter than viewport is blank-padded", () => {
  const state: TranscriptState = {
    messages: alphaTranscript(2),
    scrollOffset: 0,
    followTail: true,
  };
  const lines = renderTranscript(state, 40, 5, THEME);
  assertEquals(lines.length, 5);
  // first two rows carry content, the rest are blank (only spaces).
  assertEquals(lineText(lines[0]), "a");
  assertEquals(lineText(lines[1]), "b");
  assertEquals(lineText(lines[2]).trim().length, 0);
  assertEquals(lineText(lines[4]).trim().length, 0);
});

Deno.test("transcript: scroll up breaks follow and moves the window up", () => {
  const state: TranscriptState = {
    messages: alphaTranscript(8),
    scrollOffset: 0,
    followTail: true,
  };
  const ctx = { contentLines: 8, viewportHeight: 3 };
  const s2 = transcriptReducer(state, { type: "ScrollUp" }, ctx);
  assertEquals(s2.followTail, false);
  assertEquals(s2.scrollOffset, 4); // maxOffset(5) - 1
  const lines = renderTranscript(s2, 40, 3, THEME);
  const texts = lines.map(lineText);
  assertEquals(texts.includes("e"), true); // rows 4,5,6 -> e,f,g
  assertEquals(texts.includes("h"), false);
});

Deno.test("transcript: scroll down to the bottom re-enables follow", () => {
  // start scrolled up one row (offset 4, not following)
  const state: TranscriptState = {
    messages: alphaTranscript(8),
    scrollOffset: 4,
    followTail: false,
  };
  const ctx = { contentLines: 8, viewportHeight: 3 };
  // one down -> offset 5 (== maxOffset) -> follow re-enabled
  const s2 = transcriptReducer(state, { type: "ScrollDown" }, ctx);
  assertEquals(s2.scrollOffset, 5);
  assertEquals(s2.followTail, true);
});

Deno.test("transcript: scroll down mid-window stays unfollowed", () => {
  const state: TranscriptState = {
    messages: alphaTranscript(12),
    scrollOffset: 3,
    followTail: false,
  };
  const ctx = { contentLines: 12, viewportHeight: 3 }; // maxOffset = 9
  const s2 = transcriptReducer(state, { type: "ScrollDown" }, ctx);
  assertEquals(s2.scrollOffset, 4);
  assertEquals(s2.followTail, false);
});

Deno.test("transcript: page up/down move by the viewport height", () => {
  const state: TranscriptState = {
    messages: alphaTranscript(12),
    scrollOffset: 9,
    followTail: false,
  };
  const ctx = { contentLines: 12, viewportHeight: 3 }; // maxOffset 9
  const up = transcriptReducer(state, { type: "PageUp" }, ctx);
  assertEquals(up.followTail, false);
  assertEquals(up.scrollOffset, 6); // 9 - 3
  // page down back toward the bottom
  const down = transcriptReducer(up, { type: "PageDown" }, ctx);
  assertEquals(down.scrollOffset, 9);
  assertEquals(down.followTail, true); // 9 >= maxOffset(9)
});

Deno.test("transcript: NewContent keeps follow (render re-pins)", () => {
  const state: TranscriptState = {
    messages: alphaTranscript(8),
    scrollOffset: 0,
    followTail: true,
  };
  const ctx = { contentLines: 8, viewportHeight: 3 };
  const s2 = transcriptReducer(state, { type: "NewContent" }, ctx);
  assertEquals(s2.followTail, true);
  // window still pinned to the bottom
  const texts = renderTranscript(s2, 40, 3, THEME).map(lineText);
  assertEquals(texts.includes("h"), true);
});

Deno.test("transcript: user message renders an accent prompt", () => {
  const state: TranscriptState = {
    messages: [{ role: "user", text: "hello there" }],
    scrollOffset: 0,
    followTail: true,
  };
  const lines = renderTranscriptContent(state, 40, THEME);
  assertEquals(lines.length >= 1, true);
  assertEquals(lineText(lines[0]).startsWith("❯"), true);
  assertEquals(hasFg(lines, THEME.accent), true);
  assertEquals(allText(lines).includes("hello there"), true);
});

Deno.test("transcript: content height equals un-windowed render length", () => {
  const state: TranscriptState = {
    messages: alphaTranscript(5),
    scrollOffset: 0,
    followTail: true,
  };
  assertEquals(transcriptContentHeight(state, 40, THEME), 5);
});

Deno.test("transcript: initialTranscript follows an empty tail", () => {
  const s = initialTranscript();
  assertEquals(s.followTail, true);
  assertEquals(s.messages.length, 0);
  const lines = renderTranscript(s, 20, 4, THEME);
  assertEquals(lines.length, 4); // all blank
});

// ===========================================================================
// tool-call
// ===========================================================================

const baseCall = (over: Partial<ToolCallView>): ToolCallView => ({
  name: "read_file",
  status: "done",
  inputSummary: "src/main.ts",
  resultLines: [],
  expanded: false,
  ...over,
});

Deno.test("tool-call: running shows a braille spinner at the given frame", () => {
  const lines = renderToolCall(baseCall({ status: "running" }), 40, THEME, 2);
  assertEquals(lines.length, 1);
  const text = lineText(lines[0]);
  assertEquals(text.startsWith("⠹"), true); // SPINNER_FRAMES[2]
  assertEquals(text.includes("read_file"), true);
  assertEquals(text.includes("src/main.ts"), true);
});

Deno.test("tool-call: done shows ● in the success colour", () => {
  const lines = renderToolCall(baseCall({ status: "done" }), 40, THEME);
  assertEquals(lineText(lines[0]).startsWith("●"), true);
  assertEquals(hasFg(lines, THEME.success), true);
});

Deno.test("tool-call: error shows ✗ in the error colour", () => {
  const lines = renderToolCall(baseCall({ status: "error" }), 40, THEME);
  assertEquals(lineText(lines[0]).startsWith("✗"), true);
  assertEquals(hasFg(lines, THEME.error), true);
});

Deno.test("tool-call: collapsed hides result lines", () => {
  const lines = renderToolCall(
    baseCall({ status: "done", resultLines: ["one", "two"], expanded: false }),
    40,
    THEME,
  );
  assertEquals(lines.length, 1);
  assertEquals(allText(lines).includes("one"), false);
});

Deno.test("tool-call: expanded tree-indents results (⎿ first, rest)", () => {
  const lines = renderToolCall(
    baseCall({ status: "done", resultLines: ["one", "two", "three"], expanded: true }),
    40,
    THEME,
  );
  // header + 3 result rows
  assertEquals(lines.length, 4);
  assertEquals(lineText(lines[1]).startsWith("⎿"), true);
  assertEquals(lineText(lines[1]).includes("one"), true);
  assertEquals(lineText(lines[2]).startsWith("  "), true);
  assertFalse(lineText(lines[2]).startsWith("⎿"));
  assertEquals(lineText(lines[3]).startsWith("  "), true);
});

Deno.test("tool-call: expanded caps at 8 lines with a +N footer", () => {
  const results = Array.from({ length: 12 }, (_, i) => `line${i}`);
  const lines = renderToolCall(
    baseCall({ status: "done", resultLines: results, expanded: true }),
    40,
    THEME,
  );
  // header + 8 shown + 1 footer
  assertEquals(lines.length, 1 + 8 + 1);
  assertEquals(lineText(lines[lines.length - 1]).includes("+4 lines"), true);
});

Deno.test("tool-call: duration formatting (ms / s)", () => {
  const ms = renderToolCall(baseCall({ status: "done", durationMs: 120 }), 40, THEME);
  assertEquals(allText(ms).includes("120ms"), true);
  const s = renderToolCall(baseCall({ status: "done", durationMs: 1500 }), 40, THEME);
  assertEquals(allText(s).includes("1.5s"), true);
});

Deno.test("tool-call: never overflows the given width", () => {
  for (const w of [40, 24, 16]) {
    const lines = renderToolCall(
      baseCall({ status: "done", inputSummary: "a/really/long/path/to/some/file.ts" }),
      w,
      THEME,
    );
    for (const line of lines) assertGreaterOrEqual(w, lineWidth(line));
  }
});

// ===========================================================================
// statusline
// ===========================================================================

Deno.test("statusline: fits exactly to width at several widths (with activity)", () => {
  const view: StatusView = {
    model: "claude-sonnet-4.5",
    tokensIn: 1234,
    tokensOut: 500,
    activity: "thinking",
    spinnerFrame: 0,
  };
  for (const w of [80, 60, 40, 28]) {
    const line = renderStatusline(view, w, THEME);
    assertEquals(lineWidth(line), w, `width ${w} should fit exactly`);
  }
});

Deno.test("statusline: idle (no activity) still fits width with metrics only", () => {
  const view: StatusView = {
    model: "claude-sonnet-4.5",
    tokensIn: 99,
    tokensOut: 0,
    activity: null,
    spinnerFrame: 0,
  };
  const line = renderStatusline(view, 60, THEME);
  assertEquals(lineWidth(line), 60);
  const text = lineText(line);
  assertEquals(text.includes("claude-sonnet-4.5"), true);
  assertEquals(text.includes("↑99"), true);
  assertEquals(text.includes("↓0"), true);
  // no spinner glyph when idle
  assertFalse(text.includes("⠋"));
});

Deno.test("statusline: activity cluster is gradient-painted (many spans)", () => {
  const view: StatusView = {
    model: "m",
    tokensIn: 0,
    tokensOut: 0,
    activity: "working",
    spinnerFrame: 3,
  };
  const line = renderStatusline(view, 40, THEME);
  // gradient returns one span per cluster -> several spans for "⠼ working"
  assert(line.spans.length > 2, "expected gradient to split the activity into spans");
  assertEquals(lineText(line).includes("working"), true);
});

Deno.test("statusline: token counts compact-format k / M", () => {
  const view: StatusView = {
    model: "m",
    tokensIn: 1500,
    tokensOut: 1_500_000,
    activity: null,
    spinnerFrame: 0,
  };
  const text = lineText(renderStatusline(view, 60, THEME));
  assertEquals(text.includes("↑1.5k"), true);
  assertEquals(text.includes("↓1.5M"), true);
});

// ===========================================================================
// approval modal — header label truncation
// ===========================================================================

const approvalTheme: ApprovalTheme = {
  border: "default",
  warning: { rgb: [1, 1, 1] },
  text: "default",
  muted: "default",
  accent: "default",
};

Deno.test("approval: header row never exceeds the box width (narrow screen, long name)", () => {
  // Repro from the issue: screenW 30 < minBoxW 40, and a long tool name. The
  // top-border label used to overflow boxW; it must now equal the border width.
  const overlay = renderApprovalOverlay(
    { approvalId: "a", toolName: "a_very_long_tool_name_here", preview: [] },
    30,
    10,
    approvalTheme,
  );
  const headerW = lineWidth(overlay.lines[0]);
  const borderW = lineWidth(overlay.lines[overlay.lines.length - 1]);
  assertEquals(headerW, borderW, "header row width must equal the modal border width");
});

Deno.test("approval: header fits the border at several narrow widths", () => {
  for (const w of [20, 24, 30, 36, 42, 50, 80]) {
    const overlay = renderApprovalOverlay(
      { approvalId: "a", toolName: "Write_Tools_Read_Files_ExecBash", preview: [] },
      w,
      12,
      approvalTheme,
    );
    const headerW = lineWidth(overlay.lines[0]);
    const borderW = lineWidth(overlay.lines[overlay.lines.length - 1]);
    assertEquals(headerW, borderW, `width ${w}: header must match border`);
  }
});

Deno.test("approval: short name on a wide screen keeps the full label", () => {
  const overlay = renderApprovalOverlay(
    { approvalId: "a", toolName: "bash", preview: [] },
    80,
    12,
    approvalTheme,
  );
  const header = lineText(overlay.lines[0]);
  assertEquals(header.includes("approval required: bash"), true);
});
