//! Frame diff → minimal ANSI output (hand-written, zero crates).
//!
//! Emission rules (see [`crate::abi::tuikit_frame_diff`]):
//! - CUP (`ESC[{row};{col}H`, 1-based) once per maximal run of changed cells;
//! - SGR is emitted only when the running style changes; the style is tracked
//!   across the whole diff call (CUP moves the cursor but leaves SGR state
//!   intact, so this is correct and minimal);
//! - within a run, each non-continuation cell's cluster bytes are concatenated;
//!   continuation cells emit nothing (their wide lead already advanced the
//!   cursor across both columns);
//! - unchanged cells emit nothing;
//! - wide→narrow replacement is handled implicitly: the new frame's cell at
//!   the old continuation column is either a real (narrow) cluster or a blank
//!   space, both non-continuation, so it is emitted and overwrites the stale
//!   half-glyph — no special case needed.

use crate::abi::{color_default, Frame};
use crate::cellbuf::frame_ref;
use crate::sgr::build_sgr;

/// Append a decimal integer to `out`.
fn push_dec(out: &mut Vec<u8>, mut n: u32) {
    if n == 0 {
        out.push(b'0');
        return;
    }
    let mut buf = [0u8; 10];
    let mut i = buf.len();
    while n > 0 {
        i -= 1;
        buf[i] = b'0' + (n % 10) as u8;
        n /= 10;
    }
    out.extend_from_slice(&buf[i..]);
}

/// Append `ESC[{row};{col}H` (1-based).
fn push_cup(out: &mut Vec<u8>, row: u32, col: u32) {
    out.extend_from_slice(b"\x1b[");
    push_dec(out, row);
    out.push(b';');
    push_dec(out, col);
    out.push(b'H');
}

/// Whether two cells differ (cluster bytes + style + continuation flag).
#[inline]
fn cells_differ(
    a_bytes: &[u8],
    a: &crate::cellbuf::Cell,
    b_bytes: &[u8],
    b: &crate::cellbuf::Cell,
) -> bool {
    a_bytes != b_bytes
        || a.fg != b.fg
        || a.bg != b.bg
        || a.attrs != b.attrs
        || a.continuation != b.continuation
}

/// Render the diff (or full paint) of `next` against `prev` into `out`.
/// When `full` is true, every cell is treated as changed and the call begins
/// with `ESC[2J` + `ESC[H`; `prev` is ignored (may be equal to `next`).
fn render(prev: Option<&Frame>, next: &Frame, caps: u32, full: bool, out: &mut Vec<u8>) {
    let w = next.w;
    let h = next.h;
    let prev_ref = match prev {
        Some(p) if p.w == w && p.h == h => Some(p),
        // Dimension mismatch is rejected by the caller before reaching here.
        Some(_) => return,
        None => None,
    };

    if full {
        out.extend_from_slice(b"\x1b[2J\x1b[H");
    }

    let mut last_style: Option<(u32, u32, u16)> = None;

    for row in 0..h {
        let mut col = 0u32;
        while col < w {
            let changed = match prev_ref {
                Some(p) => cells_differ(
                    p.cluster_bytes(row, col),
                    p.cell(row, col),
                    next.cluster_bytes(row, col),
                    next.cell(row, col),
                ),
                None => true,
            };
            if !changed {
                col += 1;
                continue;
            }
            // Start of a changed run: one CUP, then walk the run.
            push_cup(out, row + 1, col + 1);
            while col < w {
                let still_changed = match prev_ref {
                    Some(p) => cells_differ(
                        p.cluster_bytes(row, col),
                        p.cell(row, col),
                        next.cluster_bytes(row, col),
                        next.cell(row, col),
                    ),
                    None => true,
                };
                if !still_changed {
                    break;
                }
                let cell = next.cell(row, col);
                let style = (cell.fg, cell.bg, cell.attrs);
                if last_style != Some(style) {
                    let seq = build_sgr(style.0, style.1, style.2, caps);
                    out.extend_from_slice(&seq);
                    last_style = Some(style);
                }
                if !cell.continuation {
                    out.extend_from_slice(next.cluster_bytes(row, col));
                }
                col += 1;
            }
        }
    }
    let _ = color_default;
}

/// Compute the diff bytes into a fresh `Vec`; `None` on dimension mismatch or
/// null frame. Diff output is small (kilobytes), so the buffer copy in
/// [`flush`] is negligible vs. the cell walk.
fn diff_into_vec(prev: *const Frame, next: *const Frame, caps: u32, full: bool) -> Option<Vec<u8>> {
    let next = frame_ref(next)?;
    let mut v = Vec::new();
    if full {
        render(None, next, caps, true, &mut v);
        return Some(v);
    }
    let prev = frame_ref(prev)?;
    if prev.w != next.w || prev.h != next.h {
        return None;
    }
    render(Some(prev), next, caps, false, &mut v);
    Some(v)
}

/// Write `bytes` into `out` (min(total, cap)); return total. Null out with
/// cap>0 → -1. Zero-byte output returns 0 regardless.
fn flush(bytes: &[u8], out: *mut u8, cap: u32) -> i64 {
    let total = bytes.len();
    if total == 0 {
        return 0;
    }
    if out.is_null() {
        return if cap == 0 { 0 } else { -1 };
    }
    let n = (total as u32).min(cap) as usize;
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, n);
    }
    total as i64
}

// ---------------------------------------------------------------------------
// FFI implementations
// ---------------------------------------------------------------------------

pub(crate) fn frame_diff_impl(
    prev: *const Frame,
    next: *const Frame,
    caps: u32,
    out: *mut u8,
    cap: u32,
) -> i64 {
    // `caps` is forwarded by the FFI surface (`tuikit_frame_diff`) so the diff
    // path quantizes SGR the same way `frame_render_full` does — keeping the
    // first paint and subsequent diffs consistent on non-truecolor terminals.
    match diff_into_vec(prev, next, caps, false) {
        Some(v) => flush(&v, out, cap),
        None => -1,
    }
}

pub(crate) fn frame_render_full_impl(
    frame: *const Frame,
    caps: u32,
    out: *mut u8,
    cap: u32,
) -> i64 {
    match diff_into_vec(frame, frame, caps, true) {
        Some(v) => flush(&v, out, cap),
        None => -1,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::abi::{
        color_default, color_named16, color_rgb, tuikit_frame_clear, tuikit_frame_create,
        tuikit_frame_diff, tuikit_frame_free, tuikit_frame_render_full, tuikit_frame_write_line,
        SpanRec, ATTR_BOLD, ATTR_REVERSE, CAP_TRUECOLOR,
    };
    use crate::cellbuf::Frame;

    fn span(text: &str, fg: u32, bg: u32, attrs: u16) -> SpanRec {
        SpanRec {
            text_ptr: text.as_ptr() as u64,
            text_len: text.len() as u32,
            fg,
            bg,
            attrs,
            _pad: 0,
        }
    }

    /// Build two frames via the implementation surface, diff them, return bytes.
    fn diff_bytes(
        w: u32,
        h: u32,
        make_prev: impl FnOnce(&mut Frame),
        make_next: impl FnOnce(&mut Frame),
    ) -> Vec<u8> {
        let prev = crate::cellbuf::frame_create_impl(w, h);
        let next = crate::cellbuf::frame_create_impl(w, h);
        unsafe {
            make_prev(&mut *prev);
            make_next(&mut *next);
        }
        let mut buf = vec![0u8; 4096];
        let total = frame_diff_impl(
            prev,
            next,
            CAP_TRUECOLOR,
            buf.as_mut_ptr(),
            buf.len() as u32,
        );
        crate::cellbuf::frame_free_impl(prev);
        crate::cellbuf::frame_free_impl(next);
        assert!(total >= 0, "diff faulted");
        buf[..total as usize].to_vec()
    }

    #[test]
    fn identical_frames_emit_nothing() {
        let b = diff_bytes(
            10,
            1,
            |f| {
                f.write_line(0, 0, &[span("hello", color_default(), color_default(), 0)]);
            },
            |f| {
                f.write_line(0, 0, &[span("hello", color_default(), color_default(), 0)]);
            },
        );
        assert!(b.is_empty(), "got {:?}", String::from_utf8_lossy(&b));
    }

    #[test]
    fn single_cell_change_is_tiny() {
        let b = diff_bytes(
            10,
            1,
            |f| {
                f.write_line(0, 0, &[span("hello", color_default(), color_default(), 0)]);
            },
            |f| {
                f.write_line(0, 0, &[span("xello", color_default(), color_default(), 0)]);
            },
        );
        // Minimal repaint: contains the changed 'x', but NOT the whole "xello"
        // run, and only one CUP sequence.
        let s = String::from_utf8_lossy(&b);
        assert!(s.contains('x'), "missing changed char: {:?}", s);
        assert!(!s.contains("xello"), "repainted unchanged tail: {:?}", s);
        // one CUP + one SGR reset
        assert_eq!(
            s.matches("\x1b[").count(),
            2,
            "expected 1 cup + 1 sgr: {:?}",
            s
        );
    }

    #[test]
    fn style_only_change_emits_sgr() {
        let b = diff_bytes(
            5,
            1,
            |f| {
                f.write_line(0, 0, &[span("abc", color_default(), color_default(), 0)]);
            },
            |f| {
                f.write_line(
                    0,
                    0,
                    &[span(
                        "abc",
                        color_rgb(255, 0, 0),
                        color_default(),
                        ATTR_BOLD,
                    )],
                );
            },
        );
        let s = String::from_utf8_lossy(&b);
        assert!(s.contains("38;2;255;0;0"), "missing fg: {:?}", s);
        assert!(
            s.contains(";1m") || s.contains(";1;"),
            "missing bold: {:?}",
            s
        );
    }

    /// Regression for the diff-caps ABI gap: the diff path must honor `caps`
    /// the same way `render_full` does, so that on a non-truecolor terminal a
    /// changed cell's RGB colour is quantized down (no raw `38;2;r;g;b`)
    /// instead of being emitted at full truecolor fidelity. Before the `caps`
    /// arg was added to `tuikit_frame_diff`, the diff path hardcoded
    /// CAP_TRUECOLOR and repainted diff cells with sequences the terminal
    /// could not display.
    #[test]
    fn diff_path_quantizes_rgb_per_caps() {
        // Build prev (plain) and next (RGB-red changed cell) directly.
        let prev = crate::cellbuf::frame_create_impl(4, 1);
        let next = crate::cellbuf::frame_create_impl(4, 1);
        unsafe {
            (&mut *prev).write_line(0, 0, &[span("a", color_default(), color_default(), 0)]);
            (&mut *next).write_line(0, 0, &[span("b", color_rgb(255, 0, 0), color_default(), 0)]);
        }
        let mut buf_tc = vec![0u8; 256];
        let total_tc = frame_diff_impl(
            prev,
            next,
            CAP_TRUECOLOR,
            buf_tc.as_mut_ptr(),
            buf_tc.len() as u32,
        );
        let mut buf_16 = vec![0u8; 256];
        let total_16 = frame_diff_impl(prev, next, 0, buf_16.as_mut_ptr(), buf_16.len() as u32);
        crate::cellbuf::frame_free_impl(prev);
        crate::cellbuf::frame_free_impl(next);
        assert!(total_tc > 0 && total_16 > 0);

        let tc = String::from_utf8_lossy(&buf_tc[..total_tc as usize]);
        let q16 = String::from_utf8_lossy(&buf_16[..total_16 as usize]);
        // Truecolor diff emits the raw RGB sequence...
        assert!(
            tc.contains("38;2;255;0;0"),
            "truecolor diff must emit RGB SGR: {:?}",
            tc
        );
        // ...and the caps=0 (16-colour) diff quantizes it away — no 38;2; leak.
        assert!(
            !q16.contains("38;2;"),
            "16-colour diff must NOT emit truecolor SGR: {:?}",
            q16
        );
        // Both still repaint the changed cluster.
        assert!(
            tc.contains('b') && q16.contains('b'),
            "missing changed text"
        );
    }

    #[test]
    fn unchanged_run_skips_sgr_repeat() {
        // Two adjacent changed cells with the SAME default style → one SGR.
        let b = diff_bytes(
            5,
            1,
            |f| {
                f.write_line(0, 0, &[span("xyz", color_default(), color_default(), 0)]);
            },
            |f| {
                f.write_line(0, 0, &[span("abz", color_default(), color_default(), 0)]);
            },
        );
        let s = String::from_utf8_lossy(&b);
        assert_eq!(s.matches("\x1b[0m").count(), 1, "repeated reset: {:?}", s);
        assert!(s.contains("ab"), "missing text: {:?}", s);
    }

    #[test]
    fn wide_to_narrow_clears_stale_continuation() {
        // prev "中x" [lead,cont,x]; next "abc" [a,b,c]. Stale right-half of 中
        // must be overwritten by 'b'. The run emits "abc".
        let b = diff_bytes(
            6,
            1,
            |f| {
                f.write_line(0, 0, &[span("中x", color_default(), color_default(), 0)]);
            },
            |f| {
                f.write_line(0, 0, &[span("abc", color_default(), color_default(), 0)]);
            },
        );
        let s = String::from_utf8_lossy(&b);
        assert!(
            s.contains("abc"),
            "should repaint abc over wide glyph: {:?}",
            s
        );
        assert!(!s.contains('\u{4E2D}'), "must not re-emit 中: {:?}", s);
    }

    #[test]
    fn wide_to_blank_clears() {
        // prev "中" (lead+cont); next blank. Both cells become non-continuation
        // spaces and are emitted, clearing the wide glyph.
        let b = diff_bytes(
            4,
            1,
            |f| {
                f.write_line(0, 0, &[span("中", color_default(), color_default(), 0)]);
            },
            |_f| { /* leave blank */ },
        );
        let s = String::from_utf8_lossy(&b);
        assert!(s.contains(' '), "should emit spaces to clear: {:?}", s);
        assert!(!s.contains('\u{4E2D}'), "must not re-emit 中: {:?}", s);
    }

    #[test]
    fn narrow_to_wide_emits_cluster_only() {
        // prev "ab"; next "中b". col0,1 change (a→中lead, b→cont). col2 'b'
        // unchanged. Run {0,1}: emit CUP + 中, skip continuation.
        let b = diff_bytes(
            4,
            1,
            |f| {
                f.write_line(0, 0, &[span("ab", color_default(), color_default(), 0)]);
            },
            |f| {
                f.write_line(0, 0, &[span("中b", color_default(), color_default(), 0)]);
            },
        );
        let s = String::from_utf8_lossy(&b);
        assert!(s.contains('\u{4E2D}'), "missing 中: {:?}", s);
        assert!(!s.contains('a'), "stale a: {:?}", s);
    }

    #[test]
    fn multi_row_diff_addresses_each_row() {
        let b = diff_bytes(
            4,
            2,
            |f| {
                f.write_line(0, 0, &[span("aaaa", color_default(), color_default(), 0)]);
                f.write_line(1, 0, &[span("aaaa", color_default(), color_default(), 0)]);
            },
            |f| {
                f.write_line(0, 0, &[span("baaa", color_default(), color_default(), 0)]);
                f.write_line(1, 0, &[span("aaab", color_default(), color_default(), 0)]);
            },
        );
        let s = String::from_utf8_lossy(&b);
        assert!(s.contains("\x1b[1;1H"), "row1 cup: {:?}", s);
        assert!(s.contains("\x1b[2;"), "row2 cup: {:?}", s);
    }

    #[test]
    fn render_full_paints_everything() {
        let f = crate::cellbuf::frame_create_impl(5, 1);
        unsafe {
            let fr = &mut *f;
            fr.write_line(
                0,
                0,
                &[span("hi", color_named16(2), color_default(), ATTR_REVERSE)],
            );
        }
        let mut buf = vec![0u8; 4096];
        let total = frame_render_full_impl(f, CAP_TRUECOLOR, buf.as_mut_ptr(), buf.len() as u32);
        crate::cellbuf::frame_free_impl(f);
        assert!(total > 0);
        let s = String::from_utf8_lossy(&buf[..total as usize]);
        assert!(s.starts_with("\x1b[2J\x1b[H"), "full paint header: {:?}", s);
        assert!(s.contains("hi"), "missing text: {:?}", s);
        assert!(
            s.contains(";7m") || s.contains(";7;"),
            "reverse attr: {:?}",
            s
        );
    }

    #[test]
    fn diff_via_ffi_surface() {
        // Exercise the #[no_mangle] entry points end to end.
        let prev = tuikit_frame_create(8, 1);
        let next = tuikit_frame_create(8, 1);
        assert!(!prev.is_null() && !next.is_null());
        let spans = [span("hi", color_default(), color_default(), 0)];
        assert_eq!(tuikit_frame_write_line(next, 0, 0, spans.as_ptr(), 1), 0);

        let mut cap = 64u32;
        let mut buf = vec![0u8; cap as usize];
        let mut total = tuikit_frame_diff(prev, next, CAP_TRUECOLOR, buf.as_mut_ptr(), cap);
        while total as u32 > cap {
            cap = total as u32;
            buf = vec![0u8; cap as usize];
            total = tuikit_frame_diff(prev, next, CAP_TRUECOLOR, buf.as_mut_ptr(), cap);
        }
        assert!(total > 0);
        let s = String::from_utf8_lossy(&buf[..total as usize]);
        assert!(s.contains("hi"));
        tuikit_frame_free(prev);
        tuikit_frame_free(next);
    }

    #[test]
    fn clear_via_ffi_then_diff_empty() {
        let prev = tuikit_frame_create(4, 1);
        let next = tuikit_frame_create(4, 1);
        let spans = [span("ab", color_default(), color_default(), 0)];
        assert_eq!(tuikit_frame_write_line(prev, 0, 0, spans.as_ptr(), 1), 0);
        assert_eq!(tuikit_frame_clear(prev), 0); // prev blank again → identical to next
        let mut buf = [0u8; 64];
        let total = tuikit_frame_diff(prev, next, CAP_TRUECOLOR, buf.as_mut_ptr(), 64);
        assert_eq!(total, 0);
        tuikit_frame_free(prev);
        tuikit_frame_free(next);
    }

    #[test]
    fn render_full_via_ffi_surface() {
        let f = tuikit_frame_create(6, 1);
        let spans = [span("hey", color_default(), color_default(), 0)];
        assert_eq!(tuikit_frame_write_line(f, 0, 0, spans.as_ptr(), 1), 0);
        let mut buf = vec![0u8; 256];
        let total = tuikit_frame_render_full(f, CAP_TRUECOLOR, buf.as_mut_ptr(), 256);
        tuikit_frame_free(f);
        assert!(total > 0);
        let s = String::from_utf8_lossy(&buf[..total as usize]);
        assert!(s.starts_with("\x1b[2J"));
        assert!(s.contains("hey"));
    }
}
