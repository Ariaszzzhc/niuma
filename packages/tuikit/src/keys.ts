// ===========================================================================
// @niuma/tuikit — incremental key-parser handle wrapper + pattern matching
// ---------------------------------------------------------------------------
// Wraps the opaque `KeyParser` state machine from `tuikit_keys_create` /
// `tuikit_keys_feed` / `tuikit_keys_free`. The parser is incremental: input
// bytes may be chunked arbitrarily (split UTF-8, split escape sequences,
// bracketed-paste bodies spanning many reads all parse correctly).
//
// The overflow retry is handled HERE: when `tuikit_keys_feed` returns more
// than the out capacity, the input was NOT consumed — we grow the out buffer
// and re-feed the same bytes until the whole output fits. Callers just see a
// clean `feed(bytes) -> InputEvent[]`.
//
// `dispose()` frees the handle exactly once; FinalizationRegistry is the net.
// ===========================================================================

import type { InputEvent, KeyMods, NamedKey } from "./binding_contract.ts";
import {
  acquireBuffer,
  decodeKeyEvents,
  releaseBuffer,
  withRetry,
} from "./buffer.ts";
import { checkHandle, ptrOf, symbols } from "./ffi.ts";

const keysRegistry = new FinalizationRegistry((handle: Deno.PointerValue) => {
  try {
    symbols().tuikit_keys_free(handle);
  } catch {
    // Library already unloaded — nothing to free.
  }
});

/**
 * Incremental key parser. Feed it raw stdin bytes; receive the events
 * completed by each chunk. Partial sequences are held internally across calls.
 */
export class KeyParser {
  #handle: Deno.PointerValue;
  #disposed = false;

  private constructor(handle: Deno.PointerValue) {
    this.#handle = handle;
    keysRegistry.register(this, handle, this);
  }

  /** Create a parser. */
  static create(): KeyParser {
    const handle = checkHandle(
      "tuikit_keys_create",
      symbols().tuikit_keys_create(),
    );
    return new KeyParser(handle);
  }

  /** Raw handle. */
  get handle(): Deno.PointerValue {
    return this.#handle;
  }

  /**
   * Feed raw input bytes; returns all events completed by this chunk. Partial
   * sequences stay buffered inside the parser. Handles the not-consumed-on-
   * overflow retry internally (grows the out buffer and re-feeds the same
   * bytes until the whole output fits).
   */
  feed(bytes: Uint8Array): InputEvent[] {
    if (this.#disposed || bytes.length === 0) return [];
    const lib = symbols();
    const inPtr = ptrOf(bytes);
    const len = bytes.length;
    const buf = acquireBuffer(256);
    try {
      const call = (outPtr: Deno.PointerValue, cap: number) =>
        lib.tuikit_keys_feed(this.#handle, inPtr, len, outPtr, cap);
      const total = withRetry(buf, call);
      return decodeKeyEvents(buf.view.subarray(0, total), total);
    } finally {
      releaseBuffer(buf);
    }
  }

  /** Free the native parser. Idempotent. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    keysRegistry.unregister(this);
    try {
      symbols().tuikit_keys_free(this.#handle);
    } catch {
      // Library unloaded — nothing to free.
    }
  }
}

// ===========================================================================
// Pattern matching — human key strings against decoded events
// ===========================================================================

/** The named keys patterns may reference. */
const NAMED_PATTERN_SET: ReadonlySet<string> = new Set<NamedKey>([
  "enter",
  "tab",
  "backspace",
  "up",
  "down",
  "right",
  "left",
  "home",
  "end",
  "pageUp",
  "pageDown",
  "insert",
  "delete",
  "f1",
  "f2",
  "f3",
  "f4",
  "f5",
  "f6",
  "f7",
  "f8",
  "f9",
  "f10",
  "f11",
  "f12",
]);

interface ParsedPattern {
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
  readonly super: boolean;
  readonly kind: "named" | "text" | "esc";
  readonly named?: NamedKey;
  readonly text?: string;
}

const MOD_WORDS = new Set([
  "ctrl",
  "control",
  "alt",
  "option",
  "meta",
  "shift",
  "super",
  "cmd",
  "win",
]);

/** Parse a "mod+mod+key" pattern. */
const parsePattern = (pattern: string): ParsedPattern => {
  const raw = pattern.toLowerCase().trim();
  if (raw.length === 0) throw new Error(`matchesKey: empty pattern`);
  const parts = raw.split("+").map((s) => s.trim()).filter((s) => s.length > 0);
  let shift = false, alt = false, ctrl = false, sup = false;
  const keyTok = parts[parts.length - 1];
  for (let i = 0; i < parts.length - 1; i++) {
    const t = parts[i];
    if (t === "ctrl" || t === "control") ctrl = true;
    else if (t === "alt" || t === "option" || t === "meta") alt = true;
    else if (t === "shift") shift = true;
    else if (t === "super" || t === "cmd" || t === "win") sup = true;
    else throw new Error(`matchesKey: unknown modifier '${t}' in '${pattern}'`);
  }
  void MOD_WORDS;
  if (keyTok === "esc" || keyTok === "escape") {
    return { shift, alt, ctrl, super: sup, kind: "esc" };
  }
  if (NAMED_PATTERN_SET.has(keyTok)) {
    return {
      shift,
      alt,
      ctrl,
      super: sup,
      kind: "named",
      named: keyTok as NamedKey,
    };
  }
  return { shift, alt, ctrl, super: sup, kind: "text", text: keyTok };
};

const modsEqual = (a: KeyMods, p: ParsedPattern): boolean =>
  a.shift === p.shift && a.alt === p.alt && a.ctrl === p.ctrl &&
  a.super === p.super;

/**
 * Test whether a decoded event matches a human pattern. Supported forms:
 *   "ctrl+c", "alt+left", "shift+tab", "enter", "esc", "a".
 *
 * Modifier matching is exact for the modern (Kitty) path. For
 * `ctrl+<letter>` we ALSO accept the legacy control-byte form, where the
 * terminal sends the raw byte (e.g. "\x03" for ctrl+c) with NO modifier
 * flags set — so matching is robust across both input protocols.
 */
export const matchesKey = (ev: InputEvent, pattern: string): boolean => {
  const p = parsePattern(pattern);
  if (p.kind === "esc") {
    return ev.kind === "esc" && !p.shift && !p.alt && !p.ctrl && !p.super;
  }
  if (ev.kind !== "text" && ev.kind !== "key") return false;
  if (p.kind === "named") {
    return ev.kind === "key" && ev.key === p.named && modsEqual(ev.mods, p);
  }
  // text pattern
  if (ev.kind !== "text") return false;
  const want = p.text!;
  // Modern (Kitty / disambiguated): the letter itself plus exact mods.
  if (ev.text.toLowerCase() === want && modsEqual(ev.mods, p)) return true;
  // Legacy ctrl+letter: terminal sends the raw control byte with no mods.
  if (p.ctrl && want.length === 1) {
    const ctrlByte = String.fromCharCode(want.charCodeAt(0) & 0x1f);
    if (ev.text === ctrlByte) return true;
  }
  return false;
};
