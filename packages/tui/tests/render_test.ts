// ===========================================================================
// @niuma/tui — component render tests
// ---------------------------------------------------------------------------
// Pure tests for the display components:
//   - transcript: scroll-window math, followTail pin, scroll-up breaks
//     follow, scroll-to-bottom re-enables, page up/down, NewContent,
//     blank padding when content < viewport, user-message prompt;
//   - tool_call: collapsed status glyphs (spinner/done/error), name+summary,
//     expanded tree indent ("⎿ " first / "  " rest), 8-line cap + footer,
//     duration formatting;
//   - footer: two-row width discipline and information hierarchy;
//   - approval panel: header label truncation at narrow widths.
// Only tuikit width/gradient (built) is required.
// ===========================================================================

import {
  assert,
  assertEquals,
  assertFalse,
  assertGreaterOrEqual,
} from "@std/assert";
import type { StyledLine } from "@niuma/tuikit";
import { stringWidth } from "@niuma/tuikit";
import { darkTheme as THEME } from "../src/theme.ts";
import {
  renderToolCall,
  type ToolCallView,
} from "../src/components/tool_call.ts";
import { type FooterView, renderFooter } from "../src/components/footer.ts";
import {
  type ApprovalTheme,
  renderApprovalPanel,
} from "../src/components/approval.ts";
import {
  type ChatMessage,
  initialTranscript,
  renderTranscript,
  renderTranscriptContent,
  transcriptContentHeight,
  transcriptReducer,
  type TranscriptState,
} from "../src/components/transcript.ts";

// Eager-load the native cdylib at module init (not inside a test) so deno's
// leak sanitizer does not attribute the long-lived library to any test.
stringWidth("niuma");

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const lineText = (line: StyledLine): string =>
  line.spans.map((s) => s.text).join("");
const lineWidth = (line: StyledLine): number =>
  line.spans.reduce((n, s) => n + stringWidth(s.text), 0);
const allText = (lines: readonly StyledLine[]): string =>
  lines.map(lineText).join("\n");
const colorEq = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
const hasFg = (lines: readonly StyledLine[], c: unknown): boolean =>
  lines.flatMap((l) => l.spans).some((s) =>
    s.style.fg !== undefined && colorEq(s.style.fg, c)
  );

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
  // assistant rows are gutter-indented ("  x")
  assertEquals(texts.includes("  f"), true); // last 3 are f,g,h
  assertEquals(texts.includes("  h"), true);
  assertEquals(texts.includes("  a"), false);
});

Deno.test("transcript: content shorter than viewport is blank-padded", () => {
  const state: TranscriptState = {
    messages: alphaTranscript(2),
    scrollOffset: 0,
    followTail: true,
  };
  const lines = renderTranscript(state, 40, 5, THEME);
  assertEquals(lines.length, 5);
  // first two rows carry content (gutter-indented), the rest are blank.
  assertEquals(lineText(lines[0]), "  a");
  assertEquals(lineText(lines[1]), "  b");
  assertEquals(lineText(lines[2]).trim().length, 0);
  assertEquals(lineText(lines[4]).trim().length, 0);
});

Deno.test("transcript: thinking renders with a ⋮ gutter, dim + italic", () => {
  const state: TranscriptState = {
    messages: [
      {
        role: "assistant",
        text: "answer",
        thinking: "let me think about this",
      },
    ],
    scrollOffset: 0,
    followTail: true,
  };
  const lines = renderTranscriptContent(state, 40, THEME);
  // thinking line sits above the markdown body, indented by the 2-cell gutter.
  assertEquals(lines.length >= 2, true);
  const thinkLine = lines[0];
  assertEquals(lineText(thinkLine).startsWith("  ⋮ "), true);
  assertEquals(lineText(thinkLine).includes("let me think about this"), true);
  const textSpan = thinkLine.spans[2]; // [indent, gutter, text]
  assertEquals(textSpan.style.italic, true);
  assertEquals(textSpan.style.dim, true);
  assertEquals(colorEq(textSpan.style.fg, THEME.textDim), true);
});

Deno.test("transcript: notice renders dim with a ─ gutter; error uses error colour", () => {
  const state: TranscriptState = {
    messages: [
      { role: "notice", text: "model: prov/m" },
      { role: "notice", text: "boom", kind: "error" },
    ],
    scrollOffset: 0,
    followTail: true,
  };
  const lines = renderTranscriptContent(state, 40, THEME);
  // notice line, blank separator, error line
  assertEquals(lines.length, 3);
  assertEquals(lineText(lines[0]).includes("─ model: prov/m"), true);
  const infoText = lines[0].spans[lines[0].spans.length - 1];
  assertEquals(infoText.style.dim, true);
  assertEquals(colorEq(infoText.style.fg, THEME.textDim), true);
  assertEquals(lineText(lines[2]).includes("boom"), true);
  const errText = lines[2].spans[lines[2].spans.length - 1];
  assertEquals(colorEq(errText.style.fg, THEME.error), true);
});

Deno.test("transcript: thinking wraps with a hanging indent", () => {
  const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
  const state: TranscriptState = {
    messages: [{ role: "assistant", text: "", thinking: long }],
    scrollOffset: 0,
    followTail: true,
  };
  const lines = renderTranscriptContent(state, 24, THEME);
  assertEquals(lines.length > 1, true);
  // First line carries the gutter (after the 2-cell indent), continuations
  // hang under the text.
  assertEquals(lineText(lines[0]).startsWith("  ⋮ "), true);
  assertEquals(lineText(lines[1]).startsWith("    "), true);
  // No line exceeds the width.
  for (const l of lines) assertGreaterOrEqual(24, lineWidth(l));
});

Deno.test("transcript: finalized thinking shows two rows and an expansion hint", () => {
  const long = Array.from({ length: 40 }, (_, i) => `thought-${i}`).join(" ");
  const state: TranscriptState = {
    messages: [{ role: "assistant", text: "", thinking: long }],
    scrollOffset: 0,
    followTail: true,
  };
  const lines = renderTranscriptContent(state, 36, THEME);
  assertEquals(lines.length, 3);
  assertEquals(lineText(lines[2]).includes("ctrl+o"), true);
});

Deno.test("transcript: expanded thinking reveals the complete block", () => {
  const long = Array.from({ length: 40 }, (_, i) => `thought-${i}`).join(" ");
  const collapsed: TranscriptState = {
    messages: [{ role: "assistant", text: "", thinking: long }],
    scrollOffset: 0,
    followTail: true,
  };
  const expanded: TranscriptState = {
    ...collapsed,
    messages: [{
      role: "assistant",
      text: "",
      thinking: long,
      detailsExpanded: true,
    }],
  };
  const collapsedLines = renderTranscriptContent(collapsed, 36, THEME);
  const expandedLines = renderTranscriptContent(expanded, 36, THEME);
  assertEquals(expandedLines.length > collapsedLines.length, true);
  assertEquals(allText(expandedLines).includes("ctrl+o"), false);
});

Deno.test("transcript: live thinking shows a spinner and only the two-line tail", () => {
  const thinking = Array.from({ length: 30 }, (_, i) => `live-${i}`).join(" ");
  const state: TranscriptState = {
    messages: [{ role: "assistant", text: "", thinking }],
    scrollOffset: 0,
    followTail: true,
  };
  const lines = renderTranscriptContent(state, 32, THEME, {
    streaming: true,
    spinnerFrame: 2,
  });
  assertEquals(lines.length, 3);
  assertEquals(lineText(lines[0]).includes("⠹ Thinking"), true);
  assertEquals(allText(lines).includes("live-0"), false);
  assertEquals(allText(lines).includes("live-29"), true);
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
  assertEquals(texts.includes("  e"), true); // rows 4,5,6 -> e,f,g
  assertEquals(texts.includes("  h"), false);
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
  // window still pinned to the bottom (gutter-indented rows)
  const texts = renderTranscript(s2, 40, 3, THEME).map(lineText);
  assertEquals(texts.includes("  h"), true);
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
// tool_call
// ===========================================================================

const baseCall = (over: Partial<ToolCallView>): ToolCallView => ({
  name: "read_file",
  status: "done",
  inputSummary: "src/main.ts",
  resultLines: [],
  expanded: false,
  ...over,
});

Deno.test("tool_call: running shows a braille spinner at the given frame", () => {
  const lines = renderToolCall(baseCall({ status: "running" }), 40, THEME, 2);
  assertEquals(lines.length, 1);
  const text = lineText(lines[0]);
  assertEquals(text.startsWith("│ ⠹"), true); // bar + SPINNER_FRAMES[2]
  assertEquals(text.includes("Read"), true);
  assertEquals(text.includes("src/main.ts"), true);
});

Deno.test("tool_call: done shows ● in the success colour", () => {
  const lines = renderToolCall(baseCall({ status: "done" }), 40, THEME);
  assertEquals(lineText(lines[0]).startsWith("│ ●"), true);
  assertEquals(hasFg(lines, THEME.success), true);
});

Deno.test("tool_call: error shows × in the error colour", () => {
  const lines = renderToolCall(baseCall({ status: "error" }), 40, THEME);
  assertEquals(lineText(lines[0]).startsWith("│ ×"), true);
  assertEquals(hasFg(lines, THEME.error), true);
});

Deno.test("tool_call: every row is framed by the dim left bar", () => {
  const lines = renderToolCall(
    baseCall({ status: "done", resultLines: ["one"], expanded: true }),
    40,
    THEME,
  );
  for (const l of lines) {
    assertEquals(lineText(l).startsWith("│ "), true);
  }
  const barSpan = lines[0].spans[0];
  assertEquals(barSpan.style.dim, true);
  assertEquals(colorEq(barSpan.style.fg, THEME.border), true);
});

Deno.test("tool_call: collapsed hides result lines", () => {
  const lines = renderToolCall(
    baseCall({ status: "done", resultLines: ["one", "two"], expanded: false }),
    40,
    THEME,
  );
  assertEquals(lines.length, 1);
  assertEquals(allText(lines).includes("one"), false);
});

Deno.test("tool_call: expanded tree-indents result rows", () => {
  const lines = renderToolCall(
    baseCall({
      status: "done",
      resultLines: ["one", "two", "three"],
      expanded: true,
    }),
    40,
    THEME,
  );
  // header + 3 result rows
  assertEquals(lines.length, 4);
  assertEquals(lineText(lines[1]).startsWith("│ ├"), true);
  assertEquals(lineText(lines[1]).includes("one"), true);
  assertEquals(lineText(lines[2]).startsWith("│ ├"), true);
  assertFalse(lineText(lines[2]).startsWith("│ └"));
  assertEquals(lineText(lines[3]).startsWith("│ └"), true);
});

Deno.test("tool_call: expanded caps at 24 visual rows with a +N footer", () => {
  const results = Array.from({ length: 30 }, (_, i) => `line${i}`);
  const lines = renderToolCall(
    baseCall({ status: "done", resultLines: results, expanded: true }),
    40,
    THEME,
  );
  // header + 24 shown + 1 footer
  assertEquals(lines.length, 1 + 24 + 1);
  assertEquals(
    lineText(lines[lines.length - 1]).includes("+6 more lines"),
    true,
  );
});

Deno.test("tool_call: duration formatting (ms / s)", () => {
  const ms = renderToolCall(
    baseCall({ status: "done", durationMs: 120 }),
    40,
    THEME,
  );
  assertEquals(allText(ms).includes("120ms"), true);
  const s = renderToolCall(
    baseCall({ status: "done", durationMs: 1500 }),
    40,
    THEME,
  );
  assertEquals(allText(s).includes("1.5s"), true);
});

Deno.test("tool_call: never overflows the given width", () => {
  for (const w of [40, 24, 16]) {
    const lines = renderToolCall(
      baseCall({
        status: "done",
        inputSummary: "a/really/long/path/to/some/file.ts",
      }),
      w,
      THEME,
    );
    for (const line of lines) assertGreaterOrEqual(w, lineWidth(line));
  }
});

Deno.test("transcript: only reads from the same assistant batch are grouped", () => {
  const state: TranscriptState = {
    messages: [
      {
        role: "tool",
        call: baseCall({
          name: "read",
          input: { path: "a.ts" },
          batchId: 1,
        }),
      },
      {
        role: "tool",
        call: baseCall({
          name: "read",
          input: { path: "b.ts" },
          batchId: 1,
        }),
      },
      {
        role: "tool",
        call: baseCall({
          name: "read",
          input: { path: "c.ts" },
          batchId: 2,
        }),
      },
    ],
    scrollOffset: 0,
    followTail: true,
  };
  const output = renderTranscriptContent(state, 60, THEME)
    .map(lineText)
    .join("\n");
  assertEquals((output.match(/Read/g) ?? []).length, 2);
  assertEquals(output.includes("2 files"), true);
  assertEquals(output.includes("c.ts"), true);
});

// ===========================================================================
// footer
// ===========================================================================

const baseFooter = (over: Partial<FooterView> = {}): FooterView => ({
  model: "",
  effort: undefined,
  tokensIn: 0,
  tokensOut: 0,
  lastInputTokens: 0,
  contextWindow: null,
  cwd: "",
  git: null,
  mcpServers: [],
  activity: null,
  spinnerFrame: 0,
  hints: [],
  ...over,
});

Deno.test("footer: both rows fit exactly at several widths", () => {
  const view = baseFooter({
    model: "claude-sonnet-4.5",
    effort: "high",
    tokensIn: 1234,
    tokensOut: 500,
    activity: "thinking",
    hints: ["ctrl+p commands", "ctrl+o details"],
  });
  for (const width of [100, 80, 60, 40, 28]) {
    const lines = renderFooter(view, width, THEME);
    assertEquals(lines.length, 2);
    assertEquals(
      lines.every((line) => lineWidth(line) === width),
      true,
      `width ${width} should fit exactly`,
    );
  }
});

Deno.test("footer: preserves activity and metrics hierarchy", () => {
  const view = baseFooter({
    model: "kimi-k3",
    effort: "medium",
    tokensIn: 1500,
    tokensOut: 1_500_000,
    lastInputTokens: 24_000,
    contextWindow: 200_000,
    activity: "generating",
    hints: ["ctrl+p commands"],
  });
  const text = allText(renderFooter(view, 100, THEME));
  assertEquals(text.includes("kimi-k3"), true);
  assertEquals(text.includes("medium"), true);
  assertEquals(text.includes("↑1.5k"), true);
  assertEquals(text.includes("↓1.5M"), true);
  assertEquals(text.includes("ctx 12%"), true);
  assertEquals(text.includes("generating"), true);
  assertEquals(text.includes("ctrl+p commands"), true);
});

Deno.test("footer: abbreviates cwd and renders git/MCP state", () => {
  const home = Deno.env.get("HOME") ?? "/home/u";
  const view = baseFooter({
    cwd: `${home}/Projects/niuma`,
    git: { branch: "main", dirty: true },
    mcpServers: [
      { id: "context7", toolCount: 2 },
      { id: "grep", toolCount: 1 },
    ],
  });
  const lines = renderFooter(view, 100, THEME);
  const text = allText(lines);
  assertEquals(text.includes("~/Projects/niuma"), true);
  assertEquals(text.includes("main"), true);
  assertEquals(text.includes("mcp 2"), true);
  const dirty = lines.flatMap((line) => line.spans).find((span) =>
    span.text.includes("±")
  );
  assert(dirty !== undefined, "expected a dirty marker");
  assertEquals(colorEq(dirty.style.fg, THEME.warning), true);
});

Deno.test("footer: MCP handshake spins while pending", () => {
  const pending = allText(
    renderFooter(baseFooter({ mcpServers: null, spinnerFrame: 0 }), 80, THEME),
  );
  assertEquals(pending.includes("⠋ mcp"), true);
});

// ===========================================================================
// approval panel — header label truncation
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
  const panel = renderApprovalPanel(
    {
      approvalId: "a",
      toolName: "a_very_long_tool_name_here",
      preview: [],
      selection: 0,
    },
    30,
    approvalTheme,
  );
  const headerW = lineWidth(panel.lines[0]);
  const borderW = lineWidth(panel.lines[panel.lines.length - 1]);
  assertEquals(
    headerW,
    borderW,
    "header row width must equal the modal border width",
  );
});

Deno.test("approval: header fits the border at several narrow widths", () => {
  for (const w of [20, 24, 30, 36, 42, 50, 80]) {
    const panel = renderApprovalPanel(
      {
        approvalId: "a",
        toolName: "Write_Tools_Read_Files_ExecBash",
        preview: [],
        selection: 0,
      },
      w,
      approvalTheme,
    );
    const headerW = lineWidth(panel.lines[0]);
    const borderW = lineWidth(panel.lines[panel.lines.length - 1]);
    assertEquals(headerW, borderW, `width ${w}: header must match border`);
  }
});

Deno.test("approval: short name on a wide screen keeps the full label", () => {
  const panel = renderApprovalPanel(
    { approvalId: "a", toolName: "bash", preview: [], selection: 0 },
    80,
    approvalTheme,
  );
  const header = lineText(panel.lines[0]);
  assertEquals(header.includes("approval required · bash"), true);
});
