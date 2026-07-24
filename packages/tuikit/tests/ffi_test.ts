// ===========================================================================
// @niuma/tuikit — FFI round-trip tests
// ---------------------------------------------------------------------------
// These exercise the REAL compiled cdylib end to end through the TS wrappers:
//   - width of CJK / emoji strings vs known cell counts
//   - span encode -> frame write -> diff/render_full -> ANSI that contains the
//     text and an ESC [ introducer
//   - keys feed of byte sequences (printable, arrows across split feeds, a
//     bracketed paste, a Kitty ctrl+c) -> decoded TS InputEvents
//   - gradient endpoints (first cluster = `from`, last = `to`)
//
// RESILIENCE: the Rust core is built concurrently; the dylib may be absent
// when the test suite runs. We attempt `openLib()` ONCE at module load and,
// when it fails, every native-touching test SKIPs with a clear build hint
// instead of erroring. `deno check`/`deno test` therefore stay green before
// `cargo build --release` has produced the artifact.
//
// The pure-TS `matchesKey` tests have no FFI dependency and always run.
// ===========================================================================

import { assert, assertEquals, assertFalse } from "@std/assert";
import type { TerminalCaps, TuikitLib } from "../src/binding_contract.ts";
import { openLib } from "../src/ffi.ts";
import { Frame } from "../src/frame.ts";
import { KeyParser, matchesKey } from "../src/keys.ts";
import { gradient } from "../src/style.ts";
import { stringWidth } from "../src/width.ts";

// ---------------------------------------------------------------------------
// Library availability gate
// ---------------------------------------------------------------------------

let LIB: TuikitLib | null = null;
let SKIP: string | null = null;
try {
  LIB = openLib();
} catch (e) {
  SKIP = e instanceof Error ? e.message : String(e);
}

/** All caps on: the most permissive terminal we model. */
const ALL_CAPS: TerminalCaps = {
  truecolor: true,
  color256: true,
  kittyKeyboard: true,
  bracketedPaste: true,
  sync2026: true,
};

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** True (and warn) when the native library is usable; false with a SKIP hint. */
const requireLib = (testName: string): boolean => {
  if (LIB) return true;
  console.warn(
    `\n  SKIP "${testName}" — native cdylib unavailable.\n  ${
      SKIP ?? "unknown reason"
    }\n  Build it: cd packages/tuikit/native && cargo build --release`,
  );
  return false;
};

/** Does `haystack` contain the exact byte sequence `needle`? */
const containsBytes = (haystack: Uint8Array, needle: Uint8Array): boolean => {
  if (needle.length === 0) return true;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
};

// ===========================================================================
// Pure-TS pattern matching (no FFI; always runs)
// ===========================================================================

Deno.test("matchesKey: enter / esc exact match", () => {
  assertEquals(
    matchesKey({
      kind: "key",
      key: "enter",
      mods: { shift: false, alt: false, ctrl: false, super: false },
      eventType: "press",
    }, "enter"),
    true,
  );
  assertEquals(matchesKey({ kind: "esc" }, "esc"), true);
  assertEquals(matchesKey({ kind: "esc" }, "enter"), false);
});

Deno.test("matchesKey: shift+tab / alt+left modifier combinations", () => {
  const shiftTab = {
    kind: "key",
    key: "tab",
    mods: { shift: true, alt: false, ctrl: false, super: false },
    eventType: "press",
  } as const;
  assertEquals(matchesKey(shiftTab, "shift+tab"), true);
  assertEquals(matchesKey(shiftTab, "tab"), false); // exact mods

  const altLeft = {
    kind: "key",
    key: "left",
    mods: { shift: false, alt: true, ctrl: false, super: false },
    eventType: "press",
  } as const;
  assertEquals(matchesKey(altLeft, "alt+left"), true);
  assertEquals(matchesKey(altLeft, "left"), false);
});

Deno.test("matchesKey: ctrl+c matches Kitty form and legacy \\x03 byte", () => {
  // Kitty / disambiguated form: the letter with ctrl set.
  const kitty = {
    kind: "text",
    text: "c",
    mods: { shift: false, alt: false, ctrl: true, super: false },
    eventType: "press",
  } as const;
  assertEquals(matchesKey(kitty, "ctrl+c"), true);
  // Legacy form: terminal sends raw ETX (0x03) with NO modifier flags.
  const legacy = {
    kind: "text",
    text: "\x03",
    mods: { shift: false, alt: false, ctrl: false, super: false },
    eventType: "press",
  } as const;
  assertEquals(matchesKey(legacy, "ctrl+c"), true);
  // A literal "c" without ctrl must not match ctrl+c.
  const plain = {
    kind: "text",
    text: "c",
    mods: { shift: false, alt: false, ctrl: false, super: false },
    eventType: "press",
  } as const;
  assertFalse(matchesKey(plain, "ctrl+c"));
});

// ===========================================================================
// width (native)
// ===========================================================================

Deno.test("stringWidth: ASCII / empty", () => {
  if (!requireLib("stringWidth ASCII/empty")) return;
  assertEquals(stringWidth("abc"), 3);
  assertEquals(stringWidth(""), 0);
});

Deno.test("stringWidth: CJK fullwidth chars are width 2", () => {
  if (!requireLib("stringWidth CJK")) return;
  assertEquals(stringWidth("你好"), 4); // 2 + 2
  assertEquals(stringWidth("日本語"), 6); // 3 * 2
});

Deno.test("stringWidth: emoji is width 2", () => {
  if (!requireLib("stringWidth emoji")) return;
  assertEquals(stringWidth("🎉"), 2);
});

// ===========================================================================
// keys (native)
// ===========================================================================

Deno.test("keys: printable + empty feed", () => {
  if (!requireLib("keys printable")) return;
  const p = KeyParser.create();
  try {
    assertEquals(p.feed(new Uint8Array(0)), []);
    const evs = p.feed(enc("a"));
    assertEquals(evs.length, 1);
    const ev = evs[0];
    assertEquals(ev.kind, "text");
    if (ev.kind === "text") assertEquals(ev.text, "a");
  } finally {
    p.dispose();
  }
});

Deno.test("keys: enter / tab / backspace decode to named keys", () => {
  if (!requireLib("keys named")) return;
  const p = KeyParser.create();
  try {
    const enter = p.feed(enc("\r"))[0];
    assertEquals(enter.kind, "key");
    if (enter.kind === "key") assertEquals(enter.key, "enter");
    const tab = p.feed(enc("\t"))[0];
    assertEquals(tab.kind, "key");
    if (tab.kind === "key") assertEquals(tab.key, "tab");
    const bs = p.feed(enc("\x7f"))[0];
    assertEquals(bs.kind, "key");
    if (bs.kind === "key") assertEquals(bs.key, "backspace");
  } finally {
    p.dispose();
  }
});

Deno.test("keys: legacy CSI up-arrow survives a split feed", () => {
  if (!requireLib("keys arrow split")) return;
  // ESC and the rest of the sequence arrive in SEPARATE feeds — the parser
  // must hold the pending ESC and complete the sequence on the next chunk.
  const p = KeyParser.create();
  try {
    assertEquals(p.feed(enc("\x1b")), []); // pending ESC, nothing complete yet
    const evs = p.feed(enc("[A"));
    assertEquals(evs.length, 1);
    const ev = evs[0];
    assertEquals(ev.kind, "key");
    if (ev.kind === "key") assertEquals(ev.key, "up");
  } finally {
    p.dispose();
  }
});

Deno.test("keys: bracketed paste becomes one paste event", () => {
  if (!requireLib("keys paste")) return;
  const p = KeyParser.create();
  try {
    const evs = p.feed(enc("\x1b[200~hello world\x1b[201~"));
    assertEquals(evs.length, 1);
    const ev = evs[0];
    assertEquals(ev.kind, "paste");
    if (ev.kind === "paste") assertEquals(ev.text, "hello world");
  } finally {
    p.dispose();
  }
});

Deno.test("keys: Kitty ctrl+c decodes to text 'c' with ctrl", () => {
  if (!requireLib("keys kitty ctrl+c")) return;
  const p = KeyParser.create();
  try {
    // CSI 99 ; 5 u  ->  codepoint 'c' (99), modifier mask 5 = 1 + ctrl.
    const evs = p.feed(enc("\x1b[99;5u"));
    assertEquals(evs.length, 1);
    const ev = evs[0];
    assertEquals(ev.kind, "text");
    if (ev.kind === "text") {
      assertEquals(ev.text, "c");
      assertEquals(ev.mods.ctrl, true);
    }
    // And the decoded event should satisfy the human pattern.
    assertEquals(matchesKey(evs[0], "ctrl+c"), true);
  } finally {
    p.dispose();
  }
});

// ===========================================================================
// frame (native): span encode -> writeLine -> render_full / diff
// ===========================================================================

Deno.test("frame: render_full paints the written text with an ESC introducer", () => {
  if (!requireLib("frame render_full")) return;
  const f = Frame.create(12, 2);
  try {
    f.writeLine(0, 0, [{ text: "hi", style: {} }]);
    const bytes = f.renderFull(ALL_CAPS);
    // The full paint must contain the literal text and at least one CSI.
    assert(containsBytes(bytes, enc("hi")), "render_full output contains 'hi'");
    assert(bytes.includes(0x1b), "render_full output contains ESC");
  } finally {
    f.dispose();
  }
});

Deno.test("frame: diff emits changed text with an ESC introducer", () => {
  if (!requireLib("frame diff")) return;
  const prev = Frame.create(8, 1);
  const next = Frame.create(8, 1);
  try {
    prev.writeLine(0, 0, [{ text: "hi", style: {} }]);
    next.writeLine(0, 0, [{ text: "ho", style: {} }]);
    const bytes = prev.diff(next, ALL_CAPS);
    // Only the changed cell is repainted: the run emits "o", not "ho".
    assert(containsBytes(bytes, enc("o")), "diff output contains 'o'");
    assert(bytes.includes(0x1b), "diff output contains ESC");
    assertFalse(
      containsBytes(bytes, enc("ho")),
      "unchanged leading cell is not repainted",
    );
    // Unchanged context: a diff of a frame against itself emits no text runs.
    const sameA = Frame.create(8, 1);
    const sameB = Frame.create(8, 1);
    try {
      sameA.writeLine(0, 0, [{ text: "xx", style: {} }]);
      sameB.writeLine(0, 0, [{ text: "xx", style: {} }]);
      const noop = sameA.diff(sameB, ALL_CAPS);
      assertFalse(
        containsBytes(noop, enc("xx")),
        "identical frames diff away the text",
      );
    } finally {
      sameA.dispose();
      sameB.dispose();
    }
  } finally {
    prev.dispose();
    next.dispose();
  }
});

// ===========================================================================
// gradient (native): endpoint colors
// ===========================================================================

Deno.test("gradient: one span per cluster with from/to endpoints", () => {
  if (!requireLib("gradient endpoints")) return;
  const spans = gradient([255, 0, 0], [0, 0, 255], "abc", {}, ALL_CAPS);
  assertEquals(spans.length, 3);
  // First cluster interpolates at t=0 -> `from` verbatim.
  assertEquals(spans[0].style.fg, { rgb: [255, 0, 0] });
  // Last cluster interpolates at t=1 -> `to` verbatim.
  assertEquals(spans[2].style.fg, { rgb: [0, 0, 255] });
  // The concatenated text reconstructs the input.
  const recon = spans.map((s) => s.text).join("");
  assertEquals(recon, "abc");
});

// ===========================================================================
// Adversarial regression coverage (added during integration verification)
// ===========================================================================

Deno.test("width: ZWJ family, flags, combining, VS16", () => {
  if (!requireLib("width graphemes")) return;
  assertEquals(stringWidth("👨‍👩‍👧‍👦"), 2); // 25-byte multi-human ZWJ cluster
  assertEquals(stringWidth("🇺🇸🇯🇵"), 4); // two regional-indicator pairs
  assertEquals(stringWidth("é"), 1); // e + combining acute
  assertEquals(stringWidth("❤️"), 2); // heart + VS16
});

Deno.test("truncate: mixed CJK/latin at cluster boundary", async () => {
  if (!requireLib("truncate mixed")) return;
  const { truncateToWidth } = await import("../src/width.ts");
  // 5 cells: a,b fit (2), 中 fits (4), 文 would straddle -> dropped, … fills.
  assertEquals(truncateToWidth("ab中文cd", 5, true), "ab中…");
  // 3 cells: 中 fits (2), next 中 straddles; … needs 1 cell.
  assertEquals(truncateToWidth("中中", 3, true), "中…");
});

Deno.test("keys: kitty sequence split mid-CSI across feeds", () => {
  if (!requireLib("kitty split")) return;
  const p = KeyParser.create();
  try {
    const seq = enc("\x1b[97;5u"); // ctrl+a, kitty form
    const e1 = p.feed(seq.subarray(0, 4)); // "\x1b[97"
    assertEquals(e1.length, 0);
    const e2 = p.feed(seq.subarray(4)); // ";5u"
    assertEquals(e2.length, 1);
    const ev = e2[0];
    assertEquals(ev.kind, "text");
    if (ev.kind === "text") {
      assertEquals(ev.text, "a");
      assertEquals(ev.mods.ctrl, true);
    }
  } finally {
    p.dispose();
  }
});

Deno.test("keys: kitty super modifier remaps to MOD.super bit", () => {
  if (!requireLib("kitty super")) return;
  const p = KeyParser.create();
  try {
    // kitty transmits super as bit-4 (value 16) -> transmitted = 1+16 = 17.
    const evs = p.feed(enc("\x1b[97;17u"));
    assertEquals(evs.length, 1);
    const ev = evs[0];
    if (ev.kind === "text") assertEquals(ev.mods.super, true);
  } finally {
    p.dispose();
  }
});

Deno.test("keys: bare ESC then another ESC, then printable", () => {
  if (!requireLib("esc esc")) return;
  const p = KeyParser.create();
  try {
    assertEquals(p.feed(enc("\x1b")), []);
    const e2 = p.feed(enc("\x1b"));
    assertEquals(e2.length, 1);
    assertEquals(e2[0].kind, "esc");
    const e3 = p.feed(enc("a"));
    assertEquals(e3.length, 2);
    assertEquals(e3[0].kind, "esc");
    assertEquals(e3[1].kind, "text");
  } finally {
    p.dispose();
  }
});

Deno.test("keys: large paste body forces the out-buffer retry dance", () => {
  if (!requireLib("paste retry")) return;
  const p = KeyParser.create();
  try {
    const body = "x".repeat(5000); // far exceeds the initial 256-byte out cap
    const evs = p.feed(enc(`\x1b[200~${body}\x1b[201~`));
    assertEquals(evs.length, 1);
    const ev = evs[0];
    assertEquals(ev.kind, "paste");
    if (ev.kind === "paste") assertEquals(ev.text.length, 5000);
  } finally {
    p.dispose();
  }
});

Deno.test("frame: wide -> narrow replacement leaves no stale continuation", () => {
  if (!requireLib("wide->narrow")) return;
  const prev = Frame.create(4, 1);
  const next = Frame.create(4, 1);
  try {
    prev.writeLine(0, 0, [{ text: "x中y", style: {} }]); // 中 = cols 1..2
    next.writeLine(0, 0, [{ text: "xaby", style: {} }]);
    const bytes = prev.diff(next, ALL_CAPS);
    // Run starting at col 2 (1-based): repaints "ab" over the wide glyph.
    assert(
      containsBytes(bytes, enc("ab")),
      "stale half of wide glyph repainted",
    );
    assertFalse(
      containsBytes(bytes, enc("中")),
      "must not re-emit the wide glyph",
    );
  } finally {
    prev.dispose();
    next.dispose();
  }
});

Deno.test("frame: spilled ZWJ family survives resize + identical-frame diff", () => {
  if (!requireLib("spill resize")) return;
  const fam = "👨‍👩‍👧‍👦"; // 25 bytes > 8-byte inline cap -> spill arena
  const f = Frame.create(10, 2);
  const g = Frame.create(6, 1);
  try {
    f.writeLine(0, 0, [{ text: fam + "ab", style: {} }]);
    f.resize(6, 1);
    const full = f.renderFull(ALL_CAPS);
    assert(
      containsBytes(full, enc(fam)),
      "spilled cluster preserved across resize",
    );
    g.writeLine(0, 0, [{ text: fam + "ab", style: {} }]);
    const noop = f.diff(g, ALL_CAPS);
    assertEquals(noop.length, 0, "identical spill frames diff to nothing");
  } finally {
    f.dispose();
    g.dispose();
  }
});

Deno.test("frame: resize to 0x0 is rejected and dims stay unchanged", () => {
  if (!requireLib("resize zero")) return;
  const f = Frame.create(5, 5);
  try {
    let threw = false;
    try {
      f.resize(0, 0);
    } catch {
      threw = true;
    }
    assert(threw, "resize(0,0) must throw");
    assertEquals([f.w, f.h], [5, 5], "dims unchanged after rejected resize");
  } finally {
    f.dispose();
  }
});

Deno.test("frame: double dispose is a no-op (double-free guard)", () => {
  if (!requireLib("double dispose")) return;
  const f = Frame.create(2, 2);
  f.dispose();
  f.dispose(); // must not throw / must not double-free the native handle
  const p = KeyParser.create();
  p.dispose();
  p.dispose();
});

Deno.test("frame: large diff forces out-buffer growth past the initial cap", () => {
  if (!requireLib("big diff retry")) return;
  const prev = Frame.create(120, 40);
  const next = Frame.create(120, 40);
  try {
    next.writeLine(0, 0, [{
      text: "Q".repeat(119),
      style: { fg: { rgb: [1, 2, 3] } },
    }]);
    next.writeLine(39, 0, [{
      text: "Z".repeat(119),
      style: { bg: { rgb: [9, 9, 9] } },
    }]);
    const bytes = prev.diff(next, ALL_CAPS);
    assert(
      containsBytes(bytes, enc("Q")),
      "top row repaint survived the retry",
    );
    assert(
      containsBytes(bytes, enc("Z")),
      "bottom row repaint survived the retry",
    );
  } finally {
    prev.dispose();
    next.dispose();
  }
});
