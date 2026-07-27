// ===========================================================================
// @niuma/tui — editor reducer table tests
// ---------------------------------------------------------------------------
// Pure reducer assertions over a table of scenarios. Each case feeds a
// sequence of InputEvents and asserts the resulting EditorState / action.
// ===========================================================================

import { assert, assertStrictEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import type { InputEvent, KeyMods, NamedKey } from "@niuma/tuikit";
// Warm the native lib at module load: renderEditor reaches stringWidth, whose
// lazy dlopen would otherwise trip the per-test resource sanitizer. Loading
// during module eval (the pattern tuikit's own ffi_test uses) avoids that.
import { stringWidth } from "@niuma/tuikit";
void stringWidth(" ");
import {
  createEditorState,
  editorIsEmpty,
  editorReducer,
  editorText,
  renderEditor,
  renderEditorSurface,
  setEditorText,
} from "../src/components/editor.ts";

// -- event builders ----------------------------------------------------------

const noMods: KeyMods = { shift: false, alt: false, ctrl: false, super: false };

const text = (ch: string, mods: Partial<KeyMods> = {}): InputEvent => ({
  kind: "text",
  text: ch,
  mods: { ...noMods, ...mods },
  eventType: "press",
});

const key = (k: NamedKey, mods: Partial<KeyMods> = {}): InputEvent => ({
  kind: "key",
  key: k,
  mods: { ...noMods, ...mods },
  eventType: "press",
});

const paste = (body: string): InputEvent => ({ kind: "paste", text: body });

/** Feed a sequence of events into a fresh editor, returning the final state
 *  and the first submit action encountered (if any). */
const feed = (
  events: readonly InputEvent[],
  start = createEditorState(),
): { state: typeof start; submit: string | null } => {
  let state = start;
  let submit: string | null = null;
  for (const ev of events) {
    const [next, action] = editorReducer(state, ev);
    state = next;
    if (action?.type === "submit") submit = action.text;
  }
  return { state, submit };
};

// ---------------------------------------------------------------------------

describe("editor: printable insert", () => {
  it("appends typed characters and tracks the caret", () => {
    const { state } = feed([text("a"), text("b"), text("c")]);
    assertStrictEquals(editorText(state), "abc");
    assertStrictEquals(state.cursor.row, 0);
    assertStrictEquals(state.cursor.col, 3);
  });

  it("inserts at the caret in the middle of the line", () => {
    const { state } = feed([text("ac"), key("left"), text("b")]);
    assertStrictEquals(editorText(state), "abc");
    assertStrictEquals(state.cursor.col, 2);
  });
});

describe("editor: paste", () => {
  it("inserts a small multi-line paste verbatim", () => {
    const { state } = feed([paste("line1\nline2\nline3")]);
    assertStrictEquals(editorText(state), "line1\nline2\nline3");
    assertStrictEquals(state.lines.length, 3);
  });

  it("collapses a >5-line paste into a marker line", () => {
    const body = Array.from({ length: 6 }, (_, i) => `l${i}`).join("\n");
    const { state } = feed([paste(body)]);
    assertStrictEquals(state.lines.length, 1);
    assertStrictEquals(state.lines[0], "[pasted 6 lines]");
  });

  it("does not collapse a 5-line paste (boundary)", () => {
    const body = Array.from({ length: 5 }, (_, i) => `l${i}`).join("\n");
    const { state } = feed([paste(body)]);
    assertStrictEquals(state.lines.length, 5);
  });
});

describe("editor: deletion", () => {
  it("backspace removes the previous char", () => {
    const { state } = feed([text("ab"), key("backspace")]);
    assertStrictEquals(editorText(state), "a");
  });

  it("backspace at col 0 joins with the previous line", () => {
    const { state } = feed([
      text("ab"),
      key("enter", { shift: true }),
      text("cd"),
      key("home"),
      key("backspace"),
    ]);
    assertStrictEquals(editorText(state), "abcd");
    assertStrictEquals(state.lines.length, 1);
  });

  it("delete removes the char at the caret", () => {
    const { state } = feed([text("ab"), key("left"), key("delete")]);
    // caret at "a|b"; delete removes "b" to the right of the caret -> "a"
    assertStrictEquals(editorText(state), "a");
  });
});

describe("editor: enter / submit", () => {
  it("plain enter submits and clears the buffer, recording history", () => {
    const { state, submit } = feed([text("hi"), key("enter")]);
    assertStrictEquals(submit, "hi");
    assert(editorIsEmpty(state));
    assertStrictEquals(state.history.length, 1);
    assertStrictEquals(state.history[0], "hi");
  });

  it("shift+enter inserts a newline instead of submitting", () => {
    const { state, submit } = feed([
      text("a"),
      key("enter", { shift: true }),
      text("b"),
    ]);
    assertStrictEquals(submit, null);
    assertStrictEquals(editorText(state), "a\nb");
  });

  it("ctrl+m also submits", () => {
    const { submit } = feed([text("yo"), text("m", { ctrl: true })]);
    assertStrictEquals(submit, "yo");
  });

  it("ctrl+j inserts a newline instead of submitting", () => {
    const { state, submit } = feed([
      text("a"),
      text("j", { ctrl: true }),
      text("b"),
    ]);
    assertStrictEquals(submit, null);
    assertStrictEquals(editorText(state), "a\nb");
  });

  it("legacy ctrl+j (raw byte 0x0a) inserts a newline", () => {
    const { state, submit } = feed([text("a"), text("\x0a"), text("b")]);
    assertStrictEquals(submit, null);
    assertStrictEquals(editorText(state), "a\nb");
  });
});

describe("editor: word jumps", () => {
  it("alt+right jumps over a word", () => {
    const { state } = feed([
      text("hello world"),
      key("home"),
      key("right", { alt: true }),
    ]);
    // after "hello " (the leading word + trailing space consumed up to "world")
    assertStrictEquals(state.cursor.col, 6);
  });

  it("alt+left jumps back over a word", () => {
    const { state } = feed([
      text("hello world"),
      key("home"),
      key("right", { alt: true }),
      key("left", { alt: true }),
    ]);
    assertStrictEquals(state.cursor.col, 0);
  });
});

describe("editor: kill ring (readline-style)", () => {
  it("ctrl+u kills to the start of the line", () => {
    const { state } = feed([
      text("abcdef"),
      key("left"),
      key("left"),
      key("left"),
      text("\x15"),
    ]);
    // legacy ctrl+u arrives as raw byte 0x15
    assertStrictEquals(editorText(state), "def");
    assertStrictEquals(state.cursor.col, 0);
  });

  it("ctrl+k kills to the end of the line", () => {
    const { state } = feed([
      text("abcdef"),
      key("left"),
      key("left"),
      key("left"),
      text("\x0b"),
    ]);
    assertStrictEquals(editorText(state), "abc");
  });

  it("ctrl+w deletes the previous word", () => {
    const { state } = feed([text("hello world"), text("\x17")]);
    assertStrictEquals(editorText(state), "hello ");
  });

  it("ctrl+a / ctrl+e move to line start / end", () => {
    const { state: s1 } = feed([text("abc"), text("\x01")]); // ctrl+a
    assertStrictEquals(s1.cursor.col, 0);
    const { state: s2 } = feed([text("abc"), key("home"), text("\x05")]); // ctrl+e
    assertStrictEquals(s2.cursor.col, 3);
  });
});

describe("editor: undo", () => {
  it("ctrl+- restores the buffer before the last edit", () => {
    const { state } = feed([
      text("hello"),
      text("-", { ctrl: true }),
    ]);
    assertStrictEquals(editorText(state), "");
  });

  it("legacy ctrl+- (raw byte 0x1f) also undoes", () => {
    const { state } = feed([text("abc"), text("\x1f")]);
    assertStrictEquals(editorText(state), "");
  });

  it("ctrl+z undoes as well", () => {
    const { state } = feed([text("abc"), text("z", { ctrl: true })]);
    assertStrictEquals(editorText(state), "");
  });

  it("each typed character is its own undo step", () => {
    const { state } = feed([
      text("a"),
      text("b"),
      text("c"),
      text("-", { ctrl: true }),
      text("-", { ctrl: true }),
    ]);
    assertStrictEquals(editorText(state), "a");
  });

  it("undo restores the cursor position too", () => {
    const { state } = feed([
      text("abc"),
      key("left"),
      text("X"),
      text("-", { ctrl: true }),
    ]);
    assertStrictEquals(editorText(state), "abc");
    assertStrictEquals(state.cursor.col, 2);
  });

  it("undo covers kills and paste", () => {
    const { state: s1 } = feed([text("hello world"), text("\x17")]); // ctrl+w
    assertStrictEquals(editorText(s1), "hello ");
    const { state: s2 } = feed([text("-", { ctrl: true })], s1);
    assertStrictEquals(editorText(s2), "hello world");

    const { state: s3 } = feed([paste("a\nb"), text("-", { ctrl: true })]);
    assertStrictEquals(editorText(s3), "");
  });

  it("undo on an empty stack is a no-op", () => {
    const { state } = feed([text("-", { ctrl: true })]);
    assertStrictEquals(editorText(state), "");
  });

  it("submit clears the undo stack", () => {
    const r = feed([text("abc"), key("enter")]);
    const { state } = feed([text("-", { ctrl: true })], r.state);
    assertStrictEquals(editorText(state), "");
  });

  it("edits after undo push a fresh snapshot", () => {
    const r1 = feed([text("abc"), text("-", { ctrl: true }), text("xy")]);
    assertStrictEquals(editorText(r1.state), "xy");
    // the new edit's checkpoint equals the post-undo (empty) buffer — one
    // undo drains "xy" entirely instead of resurrecting "abc".
    const { state } = feed([text("-", { ctrl: true })], r1.state);
    assertStrictEquals(editorText(state), "");
  });
});

describe("editor: history", () => {
  it("up/down recall previously submitted prompts", () => {
    let state = createEditorState();
    const submitted: string[] = [];
    for (const prompt of ["first", "second"]) {
      const r = feed([text(prompt), key("enter")], state);
      state = r.state;
      if (r.submit) submitted.push(r.submit);
    }
    assertStrictEquals(submitted.join(","), "first,second");

    // up -> most recent ("second")
    const [s1] = editorReducer(state, key("up"));
    assertStrictEquals(editorText(s1), "second");
    // up -> older ("first")
    const [s2] = editorReducer(s1, key("up"));
    assertStrictEquals(editorText(s2), "first");
    // down -> back to "second"
    const [s3] = editorReducer(s2, key("down"));
    assertStrictEquals(editorText(s3), "second");
    // down past newest -> restores the (empty) draft
    const [s4] = editorReducer(s3, key("down"));
    assertStrictEquals(editorText(s4), "");
    assertStrictEquals(s4.historyCursor, null);
  });

  it("history preserves an in-progress draft", () => {
    let state = createEditorState();
    const r = feed([text("first"), key("enter")], state);
    state = r.state;
    // start a draft, then browse history and come back
    const d1 = feed([text("partial")], state).state;
    const [up] = editorReducer(d1, key("up"));
    assertStrictEquals(editorText(up), "first");
    const [down] = editorReducer(up, key("down"));
    assertStrictEquals(editorText(down), "partial");
  });

  it("up/down navigate rows when the buffer is multi-line", () => {
    const { state } = feed([
      text("line0"),
      key("enter", { shift: true }),
      text("line1"),
    ]);
    assertStrictEquals(state.lines.length, 2);
    const [up] = editorReducer(state, key("up"));
    assertStrictEquals(up.cursor.row, 0);
  });
});

describe("editor: render", () => {
  it("produces a bordered box with top + bottom borders", () => {
    const state = feed([text("hi")]).state;
    const lines = renderEditor(state, 30, true, {
      border: { rgb: [1, 1, 1] },
      borderFocused: { rgb: [5, 5, 5] },
      accent: { rgb: [2, 2, 2] },
      text: { rgb: [3, 3, 3] },
      placeholder: { rgb: [4, 4, 4] },
    });
    assert(lines.length >= 3); // top + content + bottom
    assertStrictEquals(lines[0].spans[0].text.startsWith("╭"), true);
    assertStrictEquals(
      lines[lines.length - 1].spans[0].text.startsWith("╰"),
      true,
    );
  });

  it("shows a dim placeholder when empty", () => {
    const state = createEditorState("type here");
    const lines = renderEditor(state, 30, true, {
      border: "default",
      borderFocused: "default",
      accent: "default",
      text: "default",
      placeholder: { rgb: [9, 9, 9] },
    });
    const content = lines[1].spans.map((s) => s.text).join("");
    assert(content.includes("type here"));
  });

  it("paints the border with borderFocused when focused, border otherwise", () => {
    const state = feed([text("hi")]).state;
    const theme = {
      border: { rgb: [1, 1, 1] } as const,
      borderFocused: { rgb: [9, 9, 9] } as const,
      accent: { rgb: [2, 2, 2] } as const,
      text: { rgb: [3, 3, 3] } as const,
      placeholder: { rgb: [4, 4, 4] } as const,
    };
    const focused = renderEditor(state, 30, true, theme);
    const unfocused = renderEditor(state, 30, false, theme);
    assertStrictEquals(
      JSON.stringify(focused[0].spans[0].style.fg),
      JSON.stringify(theme.borderFocused),
    );
    assertStrictEquals(
      JSON.stringify(unfocused[0].spans[0].style.fg),
      JSON.stringify(theme.border),
    );
  });
});

describe("editor: purity", () => {
  it("does not mutate the input state", () => {
    const before = createEditorState();
    const snapshot = JSON.stringify(before);
    editorReducer(before, text("x"));
    assertStrictEquals(JSON.stringify(before), snapshot);
  });
});

// ---------------------------------------------------------------------------
// grapheme-aware cursor (emoji / combining sequences move + render as one cell)
// ---------------------------------------------------------------------------

describe("editor: grapheme cursor", () => {
  it("arrow-left steps one grapheme at a time across an emoji", () => {
    // "a👪b" is 3 graphemes but 4 UTF-16 code units. The caret must step
    // 3 -> 2 -> 1 -> 0 (one cluster per press), never landing mid-surrogate.
    const { state } = feed([text("a"), text("👪"), text("b")]);
    assertStrictEquals(editorText(state), "a👪b");
    assertStrictEquals(state.cursor.col, 3);

    const [s1] = editorReducer(state, key("left"));
    assertStrictEquals(s1.cursor.col, 2);
    const [s2] = editorReducer(s1, key("left"));
    assertStrictEquals(s2.cursor.col, 1);
    const [s3] = editorReducer(s2, key("left"));
    assertStrictEquals(s3.cursor.col, 0);
  });

  it("backspace removes a whole emoji cluster, not a surrogate half", () => {
    const { state } = feed([text("a"), text("👪")]);
    assertStrictEquals(editorText(state), "a👪");
    const [after] = editorReducer(state, key("backspace"));
    assertStrictEquals(editorText(after), "a");
    assertStrictEquals(after.cursor.col, 1);
  });

  it("delete removes a whole emoji cluster at the caret", () => {
    // "a👪b", caret between 'a' and the emoji (col 1) -> delete drops the emoji
    const base = feed([text("a"), text("👪"), text("b")]).state;
    const [at1] = editorReducer(base, key("left")); // 3 -> 2
    const [atA] = editorReducer(at1, key("left")); // 2 -> 1
    assertStrictEquals(atA.cursor.col, 1);
    const [after] = editorReducer(atA, key("delete"));
    assertStrictEquals(editorText(after), "ab");
  });

  it("word jump treats an emoji as part of a word (never splits it)", () => {
    const { state } = feed([text("hello 👪world")]);
    const [home] = editorReducer(state, key("home"));
    const [jumped] = editorReducer(home, key("right", { alt: true }));
    // lands after "hello " (6 clusters), the emoji stays attached to "world"
    assertStrictEquals(jumped.cursor.col, 6);
  });

  it("places the hardware caret before a whole emoji cluster", () => {
    // caret on the emoji (col 1 of "a👪b"); the cursor cell is after "a".
    const base = feed([text("a"), text("👪"), text("b")]).state;
    const [atEmoji] = editorReducer(base, key("left")); // 3 -> 2
    const [onEmoji] = editorReducer(atEmoji, key("left")); // 2 -> 1
    const surface = renderEditorSurface(onEmoji, 30, true, {
      border: "default",
      borderFocused: "default",
      accent: "default",
      text: "default",
      placeholder: "default",
    });
    assertStrictEquals(surface.cursor?.row, 1);
    assertStrictEquals(surface.cursor?.col, 5);
    assertStrictEquals(surface.cursor?.shape, "bar");
  });

  it("a ZWJ family sequence is one caret step", () => {
    const family = "👨‍👩‍👧"; // one grapheme cluster
    const { state } = feed([text("a"), text(family), text("b")]);
    assertStrictEquals(state.cursor.col, 3); // a | family | b
    const [s1] = editorReducer(state, key("left"));
    assertStrictEquals(s1.cursor.col, 2);
    const [after] = editorReducer(s1, key("backspace"));
    assertStrictEquals(editorText(after), "ab");
  });
});

describe("editor: visual wrapping", () => {
  const theme = {
    border: "default" as const,
    borderFocused: "default" as const,
    accent: "default" as const,
    text: "default" as const,
    placeholder: "default" as const,
  };

  it("wraps long input and keeps the caret on the visible row", () => {
    const state = feed([text("abcdefghijklmnop")]).state;
    const surface = renderEditorSurface(state, 12, true, theme, 2);
    // 12 cells leaves 6 content cells, so the editor has three visual rows;
    // maxRows=2 keeps the last two, including the caret.
    assertStrictEquals(surface.lines.length, 4);
    assertStrictEquals(surface.cursor?.row, 2);
    assertStrictEquals(surface.cursor?.col, 8);
  });

  it("does not expose a hardware cursor while unfocused", () => {
    const state = feed([text("hello")]).state;
    const surface = renderEditorSurface(state, 30, false, theme);
    assertStrictEquals(surface.cursor, undefined);
  });

  it("seeds external text using grapheme columns", () => {
    const state = setEditorText(createEditorState(), "a👨‍👩‍👧");
    assertStrictEquals(state.cursor.col, 2);
  });
});
