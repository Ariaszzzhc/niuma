//! # @niuma/tuikit — FFI ABI contract (Rust side)
//!
//! This file defines the *entire* C ABI surface of `libniuma_tuikit` and
//! nothing else. It is the single source of truth mirrored by
//! `packages/tuikit/src/binding-contract.ts`; any change here MUST be
//! reflected there (symbol names, parameter order, record layouts,
//! constants).
//!
//! ## Global conventions
//!
//! - **Ownership / buffers.** The caller (TS via `Deno.dlopen`) allocates
//!   every output buffer and passes `(out_ptr, out_cap)`. Rust writes
//!   `min(total, out_cap)` bytes and returns the *total* number of bytes
//!   needed as `i64`. If the return value exceeds `out_cap`, TS grows the
//!   buffer to the returned size and calls again (the "retry dance").
//!   Input buffers are borrowed for the duration of the call only; Rust
//!   never retains caller pointers.
//! - **Opaque handles.** `Frame` and `KeyParser` cross the boundary as
//!   `*mut` produced by the paired `*_create` and released ONLY by the
//!   paired `*_free`. TS wraps them with `FinalizationRegistry` as a
//!   safety net, but deterministic `dispose()` is the contract. Handles
//!   are not thread-safe; the TS loop is single-threaded.
//! - **Panic safety.** Every `extern "C"` fn is wrapped in
//!   `catch_unwind`. A panic NEVER crosses the FFI boundary: functions
//!   return `-1` (or null for handle-returning functions). `-1` therefore
//!   unambiguously means "native fault".
//! - **Binary only.** No JSON, no serde. All cross-boundary records are
//!   `#[repr(C)]` fixed-layout structs decoded on the TS side with
//!   `DataView`. All multi-byte fields are little-endian (every supported
//!   target is LE).
//!
//! ## Color representation (`u32`, tagged)
//!
//! ```text
//!   bits 31..30 : tag
//!   bits 29..0  : payload (tag-dependent)
//!
//!   tag 0  default      payload = 0                     (terminal default)
//!   tag 1  named16      payload low byte = palette idx  (0..15; 0-7 normal,
//!                                                         8-15 bright)
//!   tag 2  indexed256   payload low byte = xterm idx    (0..255)
//!   tag 3  rgb          payload = r<<16 | g<<8 | b      (8-bit channels)
//! ```
//!
//! Helpers: [`color_default`], [`color_named16`], [`color_indexed256`],
//! [`color_rgb`]. The same encoding is used for `fg` and `bg` everywhere.
//!
//! ## Attribute bitflags (`u16`)
//!
//! See the `ATTR_*` constants below. Bits 6..15 are reserved and MUST be
//! written as 0; Rust ignores unknown bits (forward-compatible).
//!
//! ## Terminal capability bitflags (`u32`, `caps`)
//!
//! TS detects capabilities (terminfo / env heuristics) and passes them in;
//! Rust never performs IO. See the `CAP_*` constants below.

use std::panic::{catch_unwind, AssertUnwindSafe};

// ---------------------------------------------------------------------------
// Constants — colors
// ---------------------------------------------------------------------------

/// Color tag: terminal default (payload must be 0).
pub const COLOR_TAG_DEFAULT: u32 = 0;
/// Color tag: named 16-color palette; payload low byte = 0..15.
pub const COLOR_TAG_NAMED16: u32 = 1;
/// Color tag: xterm 256-color palette; payload low byte = 0..255.
pub const COLOR_TAG_INDEXED256: u32 = 2;
/// Color tag: 24-bit RGB; payload = r<<16 | g<<8 | b.
pub const COLOR_TAG_RGB: u32 = 3;

/// Tag lives in the top two bits of the u32.
pub const COLOR_TAG_SHIFT: u32 = 30;

/// Build a default color word.
pub const fn color_default() -> u32 {
    COLOR_TAG_DEFAULT << COLOR_TAG_SHIFT
}
/// Build a named-16 color word. `idx` is 0..15.
pub const fn color_named16(idx: u8) -> u32 {
    (COLOR_TAG_NAMED16 << COLOR_TAG_SHIFT) | (idx as u32)
}
/// Build an indexed-256 color word. `idx` is 0..255.
pub const fn color_indexed256(idx: u8) -> u32 {
    (COLOR_TAG_INDEXED256 << COLOR_TAG_SHIFT) | (idx as u32)
}
/// Build a 24-bit RGB color word.
pub const fn color_rgb(r: u8, g: u8, b: u8) -> u32 {
    (COLOR_TAG_RGB << COLOR_TAG_SHIFT) | ((r as u32) << 16) | ((g as u32) << 8) | (b as u32)
}

// ---------------------------------------------------------------------------
// Constants — attribute bitflags (u16)
// ---------------------------------------------------------------------------

pub const ATTR_BOLD: u16 = 1 << 0;
pub const ATTR_DIM: u16 = 1 << 1;
pub const ATTR_ITALIC: u16 = 1 << 2;
pub const ATTR_UNDERLINE: u16 = 1 << 3;
pub const ATTR_STRIKETHROUGH: u16 = 1 << 4;
pub const ATTR_REVERSE: u16 = 1 << 5;
// bits 6..15 reserved, must be written as 0.

// ---------------------------------------------------------------------------
// Constants — terminal capability bitflags (u32, `caps`)
// ---------------------------------------------------------------------------

/// Terminal supports 256 colors (TERM contains 256color).
pub const CAP_COLOR_256: u32 = 1 << 0;
/// Terminal supports 24-bit truecolor (COLORTERM=truecolor/24bit).
pub const CAP_TRUECOLOR: u32 = 1 << 1;
/// Otherwise colors are quantized down to the named 16 palette.
/// bit 2 reserved
/// Terminal supports the Kitty keyboard protocol (CSI u).
pub const CAP_KITTY_KEYBOARD: u32 = 1 << 3;
/// Terminal supports bracketed paste (always assumed unless dumb).
pub const CAP_BRACKETED_PASTE: u32 = 1 << 4;
/// Terminal supports synchronized output (CSI 2026).
pub const CAP_SYNC_2026: u32 = 1 << 5;
// bits 6..31 reserved, must be written as 0.

// ---------------------------------------------------------------------------
// Constants — key event records
// ---------------------------------------------------------------------------

/// Size in bytes of one fixed-layout key event record. See [`KeyEventRec`].
pub const KEY_EVENT_REC_SIZE: usize = 16;

/// `KeyEventRec.kind`: keyboard event (press / repeat / release).
pub const KEY_KIND_KEY: u8 = 0;
/// `KeyEventRec.kind`: bracketed-paste event; payload holds the pasted text.
pub const KEY_KIND_PASTE: u8 = 1;
/// `KeyEventRec.kind`: bare ESC key (escape seen, no following bytes within
/// the parser's timeout-free "end of current chunk" rule).
pub const KEY_KIND_ESC: u8 = 2;
/// `KeyEventRec.kind`: SGR mouse report (`ESC[<b;x;yM/m`). The button id is in
/// `key_code` (64 = wheel up, 65 = wheel down, 0..2 = left/mid/right press),
/// the position is packed into the payload arena as 4 LE bytes `[x, y]`
/// (1-based terminal cells), and `mods` carries the modifier bits from the
/// report. `event_type` is PRESS for `M` (down/wheel) and RELEASE for `m`.
pub const KEY_KIND_MOUSE: u8 = 3;
// kind values 4..255 reserved.

/// `KeyEventRec.key_code` values for KEY_KIND_MOUSE events. Codes 0..2 are
/// button presses (left/middle/right); the wheel codes mirror the SGR button
/// number's low bits so TS can pass the raw button id through verbatim.
pub const MOUSE_BUTTON_LEFT: u16 = 0;
pub const MOUSE_BUTTON_MIDDLE: u16 = 1;
pub const MOUSE_BUTTON_RIGHT: u16 = 2;
pub const MOUSE_WHEEL_UP: u16 = 64;
pub const MOUSE_WHEEL_DOWN: u16 = 65;

/// `KeyEventRec.event_type` (Kitty CSI u third-param event types).
pub const KEY_EVENT_PRESS: u8 = 1;
pub const KEY_EVENT_REPEAT: u8 = 2;
pub const KEY_EVENT_RELEASE: u8 = 3;
/// Non-Kitty input always reports PRESS.
pub const KEY_EVENT_LEGACY: u8 = 0;

// Modifier mask bits (Kitty encoding: mask = 1 + bits; we store the decoded
// bits, i.e. the Kitty value minus 1).
pub const MOD_SHIFT: u8 = 1 << 0;
pub const MOD_ALT: u8 = 1 << 1;
pub const MOD_CTRL: u8 = 1 << 2;
pub const MOD_SUPER: u8 = 1 << 3;

// `KeyEventRec.key_code` values. Printable text events carry key_code =
// KEY_CODE_TEXT and the text in the payload arena. Named keys use the codes
// below.
pub const KEY_CODE_TEXT: u16 = 0; // printable text (see payload)
pub const KEY_CODE_ENTER: u16 = 1;
pub const KEY_CODE_TAB: u16 = 2;
pub const KEY_CODE_BACKSPACE: u16 = 3;
pub const KEY_CODE_UP: u16 = 4;
pub const KEY_CODE_DOWN: u16 = 5;
pub const KEY_CODE_RIGHT: u16 = 6;
pub const KEY_CODE_LEFT: u16 = 7;
pub const KEY_CODE_HOME: u16 = 8;
pub const KEY_CODE_END: u16 = 9;
pub const KEY_CODE_PAGE_UP: u16 = 10;
pub const KEY_CODE_PAGE_DOWN: u16 = 11;
pub const KEY_CODE_INSERT: u16 = 12;
pub const KEY_CODE_DELETE: u16 = 13;
pub const KEY_CODE_F1: u16 = 14;
pub const KEY_CODE_F2: u16 = 15;
pub const KEY_CODE_F3: u16 = 16;
pub const KEY_CODE_F4: u16 = 17;
pub const KEY_CODE_F5: u16 = 18;
pub const KEY_CODE_F6: u16 = 19;
pub const KEY_CODE_F7: u16 = 20;
pub const KEY_CODE_F8: u16 = 21;
pub const KEY_CODE_F9: u16 = 22;
pub const KEY_CODE_F10: u16 = 23;
pub const KEY_CODE_F11: u16 = 24;
pub const KEY_CODE_F12: u16 = 25;
// 26..65535 reserved.

// ---------------------------------------------------------------------------
// Constants — span records
// ---------------------------------------------------------------------------

/// Size in bytes of one input span record. See [`SpanRec`].
pub const SPAN_REC_SIZE: usize = 24;

/// Size in bytes of one gradient output span record. See [`GradSpanRec`].
pub const GRAD_SPAN_REC_SIZE: usize = 16;

// ---------------------------------------------------------------------------
// Binary record layouts
// ---------------------------------------------------------------------------

/// Input span record — one styled run of text written into a frame.
///
/// Written by TS (`DataView`) and read by Rust; array passed to
/// [`tuikit_frame_write_line`]. Fixed layout, 24 bytes, all fields LE:
///
/// ```text
///   offset  size  field
///   0       8     text_ptr   u64   pointer to UTF-8 bytes (borrowed, call-scoped)
///   8       4     text_len   u32   byte length of text (NOT width, NOT chars)
///   12      4     fg         u32   tagged color word (see module docs)
///   16      4     bg         u32   tagged color word
///   20      2     attrs      u16   ATTR_* bitflags
///   22      2     _pad           must be 0
/// ```
#[repr(C)]
#[derive(Clone, Copy)]
pub struct SpanRec {
    pub text_ptr: u64,
    pub text_len: u32,
    pub fg: u32,
    pub bg: u32,
    pub attrs: u16,
    pub _pad: u16,
}

const _: () = assert!(std::mem::size_of::<SpanRec>() == SPAN_REC_SIZE);

/// Key event record — one decoded input event.
///
/// Written by Rust into the caller's out buffer; 16 bytes fixed, LE:
///
/// ```text
///   offset  size  field
///   0       1     kind        u8   KEY_KIND_* (key / paste / esc)
///   1       1     event_type  u8   KEY_EVENT_* (press/repeat/release; 0=legacy)
///   2       2     key_code    u16  KEY_CODE_* (0 = text in payload)
///   4       1     mods        u8   MOD_* bitflags (Kitty mask-1 already applied)
///   5       1     _pad             must be 0
///   6       2     text_len    u16  byte length of payload (text / paste body)
///   8       4     text_ofs    u32  offset of payload within the payload arena
///   12      4     _reserved        must be 0
/// ```
///
/// **Payload arena.** `tuikit_keys_feed` lays its out buffer out as:
/// `[ N * KeyEventRec (16B each) ][ payload arena bytes ]`. The count N is
/// written into the first 4 bytes of the buffer as a LE u32 header, so the
/// full layout is:
///
/// ```text
///   offset 0     : u32 event_count
///   offset 4     : event_count * 16 bytes of KeyEventRec
///   offset 4+16N : payload arena (concatenated text/paste bytes)
/// ```
///
/// `text_ofs` is relative to the START OF THE BUFFER (not the arena), so TS
/// reads payload as `buf.subarray(text_ofs, text_ofs + text_len)`. Events
/// with `text_len == 0` have no payload. A payload never straddles calls;
/// partial multibyte sequences are buffered inside the parser until complete.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct KeyEventRec {
    pub kind: u8,
    pub event_type: u8,
    pub key_code: u16,
    pub mods: u8,
    pub _pad: u8,
    pub text_len: u16,
    pub text_ofs: u32,
    pub _reserved: u32,
}

const _: () = assert!(std::mem::size_of::<KeyEventRec>() == KEY_EVENT_REC_SIZE);

/// Gradient output span record — one per grapheme cluster of the input text.
///
/// Written by Rust from [`tuikit_gradient`]; 16 bytes fixed, LE:
///
/// ```text
///   offset  size  field
///   0       4     byte_ofs   u32  offset of cluster start in the ORIGINAL
///                                 input text (UTF-8 bytes)
///   4       4     byte_len   u32  byte length of the cluster
///   8       4     fg         u32  interpolated tagged color word (tag matches
///                                 what `caps` allows: rgb / 256 / 16)
///   12      4     bg         u32  always the input `bg` word, verbatim
/// ```
///
/// TS turns records + the original text into StyledSpan[] with the
/// requested `attrs` applied. Interpolation is linear in RGB space over
/// cluster index (0..n-1); single-cluster text gets `from_rgb`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct GradSpanRec {
    pub byte_ofs: u32,
    pub byte_len: u32,
    pub fg: u32,
    pub bg: u32,
}

const _: () = assert!(std::mem::size_of::<GradSpanRec>() == GRAD_SPAN_REC_SIZE);

// ---------------------------------------------------------------------------
// Opaque handle types
// ---------------------------------------------------------------------------

// The real `Frame` / `KeyParser` structs live in their implementation modules
// (cellbuf.rs / keys.rs) where their private layout is defined. They are
// re-exported here so the `extern "C"` signatures below reference a single
// type name; the C ABI surface (`*mut Frame`) is unchanged — the layout has
// always been private to the crate.
pub use crate::cellbuf::Frame;
pub use crate::keys::KeyParser;

// ---------------------------------------------------------------------------
// width
// ---------------------------------------------------------------------------

/// Display width of a UTF-8 string in terminal cells.
///
/// Rules (hand-written, no unicode crates): EAW Wide/Fullwidth = 2 via an
/// embedded compact sorted interval table covering CJK + emoji blocks;
/// combining marks, control chars and zero-width joiners/variation
/// selectors = 0; everything else = 1. Emoji ZWJ chains, VS16-emoji and
/// regional-indicator flag pairs count as width 2 for the whole cluster —
/// the width is computed over grapheme clusters (minimal hand-written
/// grapheme rules), not raw codepoints.
///
/// - `ptr`/`len`: borrowed UTF-8 bytes. Invalid UTF-8 is tolerated: each
///   bad byte counts as width 1 (never panics, never errors).
/// - Returns the width in cells, or `-1` on native panic.
/// - Null `ptr` with `len == 0` is legal and returns 0; null with
///   `len > 0` returns -1.
#[no_mangle]
pub extern "C" fn tuikit_width(ptr: *const u8, len: u32) -> i64 {
    catch_unwind(AssertUnwindSafe(|| width_impl(ptr, len))).unwrap_or(-1)
}

/// Truncate a UTF-8 string to at most `max_width` display cells.
///
/// Clipping happens at grapheme-cluster boundaries: a cluster that would
/// straddle the limit is dropped entirely. If truncation occurred and
/// `ellipsis` is non-zero, a single "…" (width 1) replaces the clipped tail,
/// itself fitting within `max_width` (a final width-2 cluster may be dropped
/// to make room). If the text already fits, the output equals the input.
///
/// - `ellipsis`: 0 = no ellipsis marker, non-zero = append "…" on truncation.
/// - Out-buffer rule: writes min(total, cap) bytes to `out`, returns total
///   bytes needed (the full truncated byte length). TS retries with a
///   bigger buffer when the return exceeds `cap`.
/// - Returns `-1` on native panic or null out with cap > 0.
#[no_mangle]
pub extern "C" fn tuikit_truncate(
    ptr: *const u8,
    len: u32,
    max_width: u32,
    ellipsis: u8,
    out: *mut u8,
    cap: u32,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| truncate_impl(ptr, len, max_width, ellipsis, out, cap)))
        .unwrap_or(-1)
}

// ---------------------------------------------------------------------------
// cellbuf — Frame
// ---------------------------------------------------------------------------

/// Create a frame of `w` x `h` cells, cleared to default-styled blanks.
///
/// A `Cell` is `{ cluster bytes (inline small array, up to 16 bytes inline,
/// longer clusters heap-stored), fg, bg, attrs }`. A wide (width-2) cluster
/// occupies its cell plus a following *continuation cell*; continuation
/// cells carry no text and are skipped by the differ.
///
/// Returns the opaque handle, or null on native panic / absurd dimensions
/// (w or h == 0, or w*h > 1_000_000).
#[no_mangle]
pub extern "C" fn tuikit_frame_create(w: u32, h: u32) -> *mut Frame {
    catch_unwind(AssertUnwindSafe(|| frame_create_impl(w, h))).unwrap_or(std::ptr::null_mut())
}

/// Free a frame. `handle` must come from [`tuikit_frame_create`] and must
/// not be used afterwards. Freeing null is a no-op. Double-free is a
/// contract violation (TS dispose() guarantees single-free).
#[no_mangle]
pub extern "C" fn tuikit_frame_free(handle: *mut Frame) {
    let _ = catch_unwind(AssertUnwindSafe(|| frame_free_impl(handle)));
}

/// Resize a frame to `w` x `h`, preserving the overlapping top-left region
/// and clearing the rest. Equivalent-cost to re-create; content beyond the
/// new bounds is discarded. Returns 0 on success, -1 on panic/invalid dims.
#[no_mangle]
pub extern "C" fn tuikit_frame_resize(handle: *mut Frame, w: u32, h: u32) -> i64 {
    catch_unwind(AssertUnwindSafe(|| frame_resize_impl(handle, w, h))).unwrap_or(-1)
}

/// Clear every cell to a default-styled blank. Returns 0, or -1 on
/// panic/null handle.
#[no_mangle]
pub extern "C" fn tuikit_frame_clear(handle: *mut Frame) -> i64 {
    catch_unwind(AssertUnwindSafe(|| frame_clear_impl(handle))).unwrap_or(-1)
}

/// Write one line of styled spans into `handle` at (`row`, `col`).
///
/// `spans` points to `span_count` consecutive [`SpanRec`] records (24 bytes
/// each) built by TS. Spans are laid down left-to-right starting at `col`;
/// each span's text is segmented into grapheme clusters which occupy
/// `cluster_width` cells each.
///
/// Clipping rules:
/// - content past the right edge is clipped at a cluster boundary — a
///   cluster that would straddle the edge is dropped, never half-drawn;
/// - if the final visible cluster is width-2 and only 1 cell remains, that
///   cell is blanked (no half-wide rendering);
/// - `row >= h` or `col >= w`: no-op, returns 0;
/// - rows are NOT scrolled; the caller owns layout.
///
/// Style per cell comes from the span record. Continuation cells inherit
/// fg/bg/attrs of their lead cell.
///
/// Returns 0 on success, -1 on panic / null handle / null spans with
/// span_count > 0 / span text that is not valid UTF-8 (invalid text is a
/// contract violation — TS encodes from string).
#[no_mangle]
pub extern "C" fn tuikit_frame_write_line(
    handle: *mut Frame,
    row: u32,
    col: u32,
    spans: *const SpanRec,
    span_count: u32,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        frame_write_line_impl(handle, row, col, spans, span_count)
    }))
    .unwrap_or(-1)
}

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

/// Diff two frames of identical dimensions and emit ANSI bytes that turn
/// the terminal state showing `prev` into `next`.
///
/// Emission rules:
/// - cursor addressing via CUP (`ESC[{row};{col}H`, 1-based) only for
///   changed runs; the cursor is NOT homed when nothing changed (empty
///   output);
/// - SGR sequences are emitted only when the style changes between
///   adjacent emitted cells; `SGR 0` is used to reset, followed by the
///   minimal attributes needed;
/// - adjacent cells with identical style are merged into one run (single
///   CUP + single SGR + concatenated text);
/// - continuation cells never emit text; when a wide cluster changes, its
///   continuation cell is repainted with the cluster (or blanked with the
///   cluster if the new content is narrower);
/// - unchanged cells emit nothing.
///
/// `caps` selects the colour depth for emitted SGR (truecolor / 256 / 16
/// quantization) — identical to [`tuikit_frame_render_full`]. This keeps the
/// diff path consistent with the first paint: on a non-truecolor terminal the
/// changed cells are quantized down the same way `render_full` quantized the
/// initial frame, so a spinner-tick diff repaints banner cells with the same
/// colour depth the terminal can actually display (no raw `38;2;r;g;b` on a
/// 16/256-colour terminal).
///
/// Out-buffer rule: writes min(total, cap) ANSI bytes, returns total bytes
/// needed. TS retry dance:
///   1. call with the pooled buffer;
///   2. if ret > cap, grow pool to ret and call again;
///   3. write buf[0..ret] to stdout.
/// The TS loop wraps these bytes in CSI 2026 sync markers
/// (`ESC[?2026h` ... `ESC[?2026l`) when caps allow — Rust does NOT emit
/// sync markers itself.
///
/// Returns -1 on panic / null handle / dimension mismatch.
#[no_mangle]
pub extern "C" fn tuikit_frame_diff(
    prev: *const Frame,
    next: *const Frame,
    caps: u32,
    out: *mut u8,
    cap: u32,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| frame_diff_impl(prev, next, caps, out, cap))).unwrap_or(-1)
}

/// Emit ANSI bytes painting the ENTIRE `frame` (first paint / full
/// redraw). Same emission rules as [`tuikit_frame_diff`] but every cell is
/// treated as changed; begins with `ESC[2J` + `ESC[H`. `caps` selects the
/// color depth for emitted SGR (truecolor / 256 / 16 quantization).
///
/// Out-buffer rule identical to [`tuikit_frame_diff`]. Returns -1 on
/// panic / null handle.
#[no_mangle]
pub extern "C" fn tuikit_frame_render_full(
    frame: *const Frame,
    caps: u32,
    out: *mut u8,
    cap: u32,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| frame_render_full_impl(frame, caps, out, cap)))
        .unwrap_or(-1)
}

// ---------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------

/// Create an incremental key parser. Returns the handle, or null on panic.
///
/// The parser is a byte-stream state machine: state persists across
/// [`tuikit_keys_feed`] calls, so input may be chunked arbitrarily —
/// multibyte UTF-8 split across reads, escape sequences split mid-way, and
/// bracketed-paste bodies spanning many reads all parse correctly.
#[no_mangle]
pub extern "C" fn tuikit_keys_create() -> *mut KeyParser {
    catch_unwind(AssertUnwindSafe(keys_create_impl)).unwrap_or(std::ptr::null_mut())
}

/// Free a key parser. Null is a no-op; handle must not be reused.
#[no_mangle]
pub extern "C" fn tuikit_keys_free(handle: *mut KeyParser) {
    let _ = catch_unwind(AssertUnwindSafe(|| keys_free_impl(handle)));
}

/// Feed raw input bytes; decode complete events into the out buffer.
///
/// Input coverage:
/// - printable UTF-8 (any chunk split) → kind=KEY, key_code=TEXT, payload
///   = the decoded text;
/// - CR / LF / TAB / BACKSPACE(0x7f & 0x08) / bare ESC;
/// - legacy CSI: arrows (A/B/C/D), Home/End (H/F, also 1~/4~),
///   PgUp/PgDn (5~/6~), Insert/Delete (2~/3~), F1-F12 including SS3 forms
///   (OP/OQ/OR/OS and 11~..24~), modifier params (`CSI 1 ; <mask> X` —
///   mask-1 math applied);
/// - SS3 arrows (`ESC O A` etc.) from application cursor mode;
/// - Alt+char: `ESC <printable>` → kind=KEY with MOD_ALT;
/// - Kitty CSI u: `CSI key:shifted:base ; mods:event-type ; text-cps u` —
///   decodes press/repeat/release, applies the modifier mask-1 rule,
///   optional text-as-codepoints payload;
/// - bracketed paste: `ESC[200~` ... `ESC[201~` → ONE kind=PASTE event,
///   payload = the full paste body (buffered across feeds until the
///   terminator arrives).
///
/// Ambiguity rule (no timers cross FFI): a bare ESC byte at the END of the
/// current chunk is held pending; if the next feed continues an escape
/// sequence it is parsed as such, otherwise the pending ESC is emitted as
/// kind=ESC before the new bytes. Alt+char therefore requires both bytes in
/// the same or consecutive feeds — standard for terminal input. A bare ESC
/// held pending when no further feed ever arrives (end of stream) is never
/// emitted — acceptable under the no-timer policy.
///
/// Malformed-byte rule: stray UTF-8 continuation bytes (`0x80..=0xbf`) and
/// invalid lead bytes (`0xc0`, `0xc1`, `0xf5..=0xff`) — which can never be
/// part of a well-formed input stream — are DROPPED silently. They are not
/// surfaced as text events (the TS layer decodes payloads with TextDecoder,
/// which would otherwise turn such bytes into U+FFFD and inject a garbage
/// '�' key event). NUL (`0x00`) is the one deliberate exception: it is
/// passed through as a text event so it round-trips verbatim.
///
/// Out buffer layout: see [`KeyEventRec`] docs — u32 count header, then
/// count*16 record bytes, then the payload arena. Out-buffer rule: writes
/// min(total, cap), returns total bytes needed; TS grows and re-feeds the
/// SAME input (feed is idempotent when out capacity was insufficient — the
/// input is consumed only when the whole output fits... therefore: when the
/// return exceeds `cap`, the input bytes have NOT been consumed and MUST be
/// passed again on the retry with the bigger buffer).
///
/// Returns -1 on panic / null handle / null out with cap>0.
#[no_mangle]
pub extern "C" fn tuikit_keys_feed(
    handle: *mut KeyParser,
    bytes: *const u8,
    len: u32,
    out: *mut u8,
    cap: u32,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| keys_feed_impl(handle, bytes, len, out, cap)))
        .unwrap_or(-1)
}

// ---------------------------------------------------------------------------
// sgr
// ---------------------------------------------------------------------------

/// Serialize a style (`fg`, `bg`, `attrs` tagged words/flags) into an SGR
/// sequence, quantized to `caps`.
///
/// Emits a complete sequence starting with `ESC[0m` (reset) followed by the
/// attributes and colors — the sequence is self-contained and safe to emit
/// at any style boundary (this is exactly what the differ needs on style
/// change). Color quantization: when `caps` lacks CAP_TRUECOLOR, RGB colors
/// quantize to the xterm 6x6x6 cube + 24-step grayscale ramp picking the
/// nearer entry (by squared distance in RGB space); without CAP_COLOR_256
/// they further quantize to the nearest of the 16 named palette colors
/// (standard xterm palette table).
///
/// Out-buffer rule: writes min(total, cap), returns total needed. SGR
/// sequences are tiny (<= 40 bytes) so a 64-byte TS buffer never retries.
/// Returns -1 on panic.
#[no_mangle]
pub extern "C" fn tuikit_sgr_style(
    fg: u32,
    bg: u32,
    attrs: u16,
    caps: u32,
    out: *mut u8,
    cap: u32,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| sgr_style_impl(fg, bg, attrs, caps, out, cap)))
        .unwrap_or(-1)
}

/// Quantize a 24-bit RGB color to an xterm 256-palette index.
///
/// Searches the 6x6x6 color cube (indices 16..231) and the 24-step
/// grayscale ramp (232..255), returns the index of the nearer by squared
/// RGB distance. Ties prefer the cube. `r`,`g`,`b` are separate u8 args
/// (not a tagged color word). Returns the index 16..255, or -1 on panic.
#[no_mangle]
pub extern "C" fn tuikit_rgb_to_256(r: u8, g: u8, b: u8) -> i64 {
    catch_unwind(AssertUnwindSafe(|| rgb_to_256_impl(r, g, b))).unwrap_or(-1)
}

/// Quantize a 24-bit RGB color to the nearest of the 16 named palette
/// colors (standard xterm palette). Returns palette index 0..15, or -1 on
/// panic.
#[no_mangle]
pub extern "C" fn tuikit_rgb_to_16(r: u8, g: u8, b: u8) -> i64 {
    catch_unwind(AssertUnwindSafe(|| rgb_to_16_impl(r, g, b))).unwrap_or(-1)
}

/// Paint `text` with a horizontal linear gradient from `from_rgb` to
/// `to_rgb`, emitting one [`GradSpanRec`] (16 bytes) per grapheme cluster.
///
/// - `from_rgb` / `to_rgb`: tagged color words; MUST both be tag RGB
///   (contract — anything else returns -1). Only their payloads are used.
/// - `text`: borrowed UTF-8; segmented with the same grapheme rules as
///   [`tuikit_width`].
/// - `caps`: decides the tag of emitted `fg` words — CAP_TRUECOLOR → RGB
///   verbatim; else CAP_COLOR_256 → indexed256 via [`tuikit_rgb_to_256`];
///   else named16 via [`tuikit_rgb_to_16`].
/// - `bg`: tagged color word copied verbatim into every record.
///
/// Out buffer: `ceil(total/16)` records; out-buffer rule as usual (total =
/// cluster_count * 16). Returns -1 on panic / bad color tags / invalid
/// UTF-8.
#[no_mangle]
pub extern "C" fn tuikit_gradient(
    from_rgb: u32,
    to_rgb: u32,
    text: *const u8,
    len: u32,
    bg: u32,
    caps: u32,
    out: *mut u8,
    cap: u32,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        gradient_impl(from_rgb, to_rgb, text, len, bg, caps, out, cap)
    }))
    .unwrap_or(-1)
}

// ---------------------------------------------------------------------------
// termplat — Windows console code page / VT mode
// ---------------------------------------------------------------------------

/// Switch the Windows console to UTF-8 (code page 65001) and enable
/// `ENABLE_VIRTUAL_TERMINAL_PROCESSING` on stdout, saving the previous code
/// pages and console modes for [`tuikit_terminal_teardown`]. Without this a
/// console on a legacy code page (e.g. 936/GBK) renders the UTF-8 output
/// stream as mojibake, and a console without VT processing ignores SGR
/// colour sequences entirely.
///
/// Idempotent: a second call while active is a no-op returning 0. On
/// non-Windows targets this is a no-op returning 0 (the symbol exists on
/// every platform so the TS symbol table always resolves).
///
/// Returns 0 on success, otherwise the first failing Win32 error code
/// (`GetLastError`). Partial failure still leaves the saved state active so
/// teardown restores whatever was changed; TS treats the return as
/// advisory and continues either way.
#[no_mangle]
pub extern "C" fn tuikit_terminal_setup() -> i64 {
    catch_unwind(AssertUnwindSafe(termplat::terminal_setup_impl)).unwrap_or(-1)
}

/// Restore the code pages and console modes saved by
/// [`tuikit_terminal_setup`]. Idempotent: calling without a matching active
/// setup is a no-op returning 0. No-op returning 0 on non-Windows targets.
///
/// Returns 0 on success, otherwise the first failing Win32 error code, or
/// -1 on native panic.
#[no_mangle]
pub extern "C" fn tuikit_terminal_teardown() -> i64 {
    catch_unwind(AssertUnwindSafe(termplat::terminal_teardown_impl)).unwrap_or(-1)
}

// ---------------------------------------------------------------------------
// Implementation delegators — bodies live in width.rs / cellbuf.rs / diff.rs /
// keys.rs / sgr.rs / termplat.rs. Keep this block free of logic so the
// contract surface above stays the single source of truth.
// ---------------------------------------------------------------------------

use crate::{cellbuf, diff, keys, sgr, termplat, width};

fn width_impl(ptr: *const u8, len: u32) -> i64 {
    width::width_impl(ptr, len)
}

fn truncate_impl(
    ptr: *const u8,
    len: u32,
    max_width: u32,
    ellipsis: u8,
    out: *mut u8,
    cap: u32,
) -> i64 {
    width::truncate_impl(ptr, len, max_width, ellipsis, out, cap)
}

fn frame_create_impl(w: u32, h: u32) -> *mut Frame {
    cellbuf::frame_create_impl(w, h)
}

fn frame_free_impl(handle: *mut Frame) {
    cellbuf::frame_free_impl(handle);
}

fn frame_resize_impl(handle: *mut Frame, w: u32, h: u32) -> i64 {
    cellbuf::frame_resize_impl(handle, w, h)
}

fn frame_clear_impl(handle: *mut Frame) -> i64 {
    cellbuf::frame_clear_impl(handle)
}

fn frame_write_line_impl(
    handle: *mut Frame,
    row: u32,
    col: u32,
    spans: *const SpanRec,
    span_count: u32,
) -> i64 {
    cellbuf::frame_write_line_impl(handle, row, col, spans, span_count)
}

fn frame_diff_impl(prev: *const Frame, next: *const Frame, caps: u32, out: *mut u8, cap: u32) -> i64 {
    diff::frame_diff_impl(prev, next, caps, out, cap)
}

fn frame_render_full_impl(frame: *const Frame, caps: u32, out: *mut u8, cap: u32) -> i64 {
    diff::frame_render_full_impl(frame, caps, out, cap)
}

fn keys_create_impl() -> *mut KeyParser {
    keys::keys_create_impl()
}

fn keys_free_impl(handle: *mut KeyParser) {
    keys::keys_free_impl(handle);
}

fn keys_feed_impl(
    handle: *mut KeyParser,
    bytes: *const u8,
    len: u32,
    out: *mut u8,
    cap: u32,
) -> i64 {
    keys::keys_feed_impl(handle, bytes, len, out, cap)
}

fn sgr_style_impl(fg: u32, bg: u32, attrs: u16, caps: u32, out: *mut u8, cap: u32) -> i64 {
    sgr::sgr_style_impl(fg, bg, attrs, caps, out, cap)
}

fn rgb_to_256_impl(r: u8, g: u8, b: u8) -> i64 {
    sgr::rgb_to_256_impl(r, g, b)
}

fn rgb_to_16_impl(r: u8, g: u8, b: u8) -> i64 {
    sgr::rgb_to_16_impl(r, g, b)
}

fn gradient_impl(
    from_rgb: u32,
    to_rgb: u32,
    text: *const u8,
    len: u32,
    bg: u32,
    caps: u32,
    out: *mut u8,
    cap: u32,
) -> i64 {
    sgr::gradient_impl(from_rgb, to_rgb, text, len, bg, caps, out, cap)
}
