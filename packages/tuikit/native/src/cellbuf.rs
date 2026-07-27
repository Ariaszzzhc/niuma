//! Cell buffer / `Frame` (hand-written, zero crates).
//!
//! A [`Frame`] is a `w * h` grid of [`Cell`]s. [`Cell`] stores one grapheme
//! cluster inline (up to [`INLINE_CAP`] bytes) plus its style; longer clusters
//! (rare: 2+ human ZWJ families) spill into a per-frame [`Vec<String>`] heap
//! arena indexed by `spill_idx`. The cluster byte storage is private — the
//! differ / renderer read it via [`Frame::cluster_bytes`].
//!
//! Design choice (documented per the task spec): inline capacity is **8
//! bytes**, which fits ASCII (1), CJK (3–4), single astral emoji (4), emoji
//! +VS16 (7), regional-indicator flags (exactly 8) and emoji+skin-tone (8).
//! Only multi-human ZWJ families (11+ bytes) spill — infrequent in a TUI, so
//! the amortized cost is one extra indirection on the rare cell.

use crate::abi::{color_default, SpanRec};
use crate::width::grapheme_spans;

/// Inline byte capacity for a cluster. Clusters longer than this spill.
pub const INLINE_CAP: usize = 8;

/// One terminal cell. `Copy` — storage is all inline primitives (the cluster
/// heap arena lives on the [`Frame`], not the cell).
#[derive(Clone, Copy)]
pub struct Cell {
    /// Inline cluster bytes (valid prefix when `spill_idx == 0`).
    inline: [u8; INLINE_CAP],
    /// Inline byte length. Ignored when `spill_idx != 0` (then read from spill).
    len: u8,
    /// 0 = cluster lives inline; else `spill_idx` (1-based) into `Frame::spills`.
    spill_idx: u32,
    /// Tagged foreground color word.
    pub fg: u32,
    /// Tagged background color word.
    pub bg: u32,
    /// Attribute bitflags (ATTR_*).
    pub attrs: u16,
    /// True for the trailing cell(s) of a width-2+ cluster (carry no text).
    pub continuation: bool,
}

impl Default for Cell {
    fn default() -> Self {
        // A default-styled blank: a single ASCII space, default colors.
        let mut inline = [0u8; INLINE_CAP];
        inline[0] = b' ';
        Cell {
            inline,
            len: 1,
            spill_idx: 0,
            fg: color_default(),
            bg: color_default(),
            attrs: 0,
            continuation: false,
        }
    }
}

impl Cell {
    /// A continuation cell inherits the lead's style; cluster text is empty.
    fn continuation_of(fg: u32, bg: u32, attrs: u16) -> Self {
        Cell {
            inline: [0u8; INLINE_CAP],
            len: 0,
            spill_idx: 0,
            fg,
            bg,
            attrs,
            continuation: true,
        }
    }

    /// Build a cell holding `cluster_bytes` with the given style. Spills when
    /// the cluster exceeds [`INLINE_CAP`].
    fn with_cluster(
        cluster_bytes: &[u8],
        fg: u32,
        bg: u32,
        attrs: u16,
        spills: &mut Vec<String>,
    ) -> Self {
        if cluster_bytes.len() <= INLINE_CAP {
            let mut inline = [0u8; INLINE_CAP];
            inline[..cluster_bytes.len()].copy_from_slice(cluster_bytes);
            Cell {
                inline,
                len: cluster_bytes.len() as u8,
                spill_idx: 0,
                fg,
                bg,
                attrs,
                continuation: false,
            }
        } else {
            let idx = spills.len() as u32 + 1; // 1-based; 0 reserved for inline
            spills.push(std::str::from_utf8(cluster_bytes).unwrap_or("").to_string());
            Cell {
                inline: [0u8; INLINE_CAP],
                len: 0,
                spill_idx: idx,
                fg,
                bg,
                attrs,
                continuation: false,
            }
        }
    }
}

/// A `w * h` cell grid. Layout is private to this crate; the FFI surface
/// hands out `*mut Frame` only. Re-exported as `abi::Frame`.
pub struct Frame {
    pub w: u32,
    pub h: u32,
    pub cells: Vec<Cell>,
    /// Heap arena for clusters longer than [`INLINE_CAP`].
    pub spills: Vec<String>,
}

impl Frame {
    /// Allocate a frame cleared to default blanks. Returns None on absurd dims.
    pub fn new(w: u32, h: u32) -> Option<Self> {
        if w == 0 || h == 0 {
            return None;
        }
        // Guard against pathological allocations.
        let area = (w as u64) * (h as u64);
        if area > 1_000_000 {
            return None;
        }
        Some(Frame {
            w,
            h,
            cells: vec![Cell::default(); area as usize],
            spills: Vec::new(),
        })
    }

    /// Index a cell (row-major). Caller validates bounds.
    #[inline]
    fn idx(&self, row: u32, col: u32) -> usize {
        (row as usize) * (self.w as usize) + (col as usize)
    }

    /// Borrow a cell.
    pub fn cell(&self, row: u32, col: u32) -> &Cell {
        &self.cells[self.idx(row, col)]
    }

    /// The cluster bytes this cell renders. Empty for continuation cells.
    pub fn cluster_bytes(&self, row: u32, col: u32) -> &[u8] {
        let c = self.cell(row, col);
        if c.continuation {
            return &[];
        }
        if c.spill_idx == 0 {
            &c.inline[..c.len as usize]
        } else {
            self.spills[(c.spill_idx - 1) as usize].as_bytes()
        }
    }

    /// Clear every cell to a default blank (also clears the spill arena).
    pub fn clear(&mut self) {
        for c in self.cells.iter_mut() {
            *c = Cell::default();
        }
        self.spills.clear();
    }

    /// Resize, preserving the overlapping top-left region, clearing the rest.
    pub fn resize(&mut self, w: u32, h: u32) -> bool {
        if w == 0 || h == 0 {
            return false;
        }
        if (w as u64) * (h as u64) > 1_000_000 {
            return false;
        }
        let old_w = self.w as usize;
        let old_h = self.h as usize;
        let new_w = w as usize;
        let new_h = h as usize;
        let mut new_cells = vec![Cell::default(); new_w * new_h];
        let copy_w = old_w.min(new_w);
        let copy_h = old_h.min(new_h);
        for r in 0..copy_h {
            let src = r * old_w;
            let dst = r * new_w;
            new_cells[dst..dst + copy_w].copy_from_slice(&self.cells[src..src + copy_w]);
        }
        self.w = w;
        self.h = h;
        self.cells = new_cells;
        // Spills remain valid (strings referenced by preserved cells still
        // index correctly into the unchanged arena).
        true
    }

    /// Write styled spans at (`row`, `col`), clipped at the right edge at a
    /// grapheme-cluster boundary. See [`crate::abi::tuikit_frame_write_line`]
    /// for the full clipping contract.
    pub fn write_line(&mut self, row: u32, col: u32, spans: &[SpanRec]) {
        if row >= self.h || col >= self.w {
            return;
        }
        let w = self.w;
        let mut cur_col = col;
        for span in spans {
            // Borrow the span text as a UTF-8 slice.
            let text_bytes = unsafe {
                let p = span.text_ptr as *const u8;
                if p.is_null() {
                    continue;
                }
                std::slice::from_raw_parts(p, span.text_len as usize)
            };
            // Contract: TS encodes from a string, so this is valid UTF-8. If it
            // is not, abort the span (write_line returns -1 at FFI layer).
            let s = match std::str::from_utf8(text_bytes) {
                Ok(s) => s,
                Err(_) => return,
            };
            let clusters = grapheme_spans(s);
            for g in clusters {
                let cluster_bytes = &s.as_bytes()[g.start..g.end];
                let gw = g.width;
                // Drop a cluster that would straddle the right edge.
                if cur_col.checked_add(gw).is_none_or(|end| end > w) {
                    // Leftover single cell at the edge when a width-2 cluster
                    // no longer fits: blank it so no stale glyph remains.
                    if cur_col < w && gw > 1 {
                        let i = self.idx(row, cur_col);
                        self.cells[i] = Cell::default();
                    }
                    return;
                }
                let i = self.idx(row, cur_col);
                self.cells[i] = Cell::with_cluster(
                    cluster_bytes,
                    span.fg,
                    span.bg,
                    span.attrs,
                    &mut self.spills,
                );
                // Continuation cell(s) for width-2 clusters.
                if gw == 2 {
                    let ci = self.idx(row, cur_col + 1);
                    self.cells[ci] = Cell::continuation_of(span.fg, span.bg, span.attrs);
                }
                cur_col += gw;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// FFI implementations (called from abi.rs)
// ---------------------------------------------------------------------------

pub(crate) fn frame_create_impl(w: u32, h: u32) -> *mut crate::abi::Frame {
    match Frame::new(w, h) {
        // `abi::Frame` is a `pub use` re-export of this `Frame`, so the cast
        // is a no-op alias kept for documentation of the handle type.
        Some(f) => Box::into_raw(Box::new(f)),
        None => std::ptr::null_mut(),
    }
}

pub(crate) fn frame_free_impl(handle: *mut crate::abi::Frame) {
    if handle.is_null() {
        return;
    }
    unsafe {
        drop(Box::from_raw(handle));
    }
}

fn as_frame_mut<'a>(handle: *mut crate::abi::Frame) -> Option<&'a mut Frame> {
    if handle.is_null() {
        return None;
    }
    // `abi::Frame` is this `Frame` (re-export), so the deref is same-type.
    unsafe { Some(&mut *handle) }
}
pub(crate) fn frame_resize_impl(handle: *mut crate::abi::Frame, w: u32, h: u32) -> i64 {
    match as_frame_mut(handle) {
        Some(f) => {
            if f.resize(w, h) {
                0
            } else {
                -1
            }
        }
        None => -1,
    }
}

pub(crate) fn frame_clear_impl(handle: *mut crate::abi::Frame) -> i64 {
    match as_frame_mut(handle) {
        Some(f) => {
            f.clear();
            0
        }
        None => -1,
    }
}

pub(crate) fn frame_write_line_impl(
    handle: *mut crate::abi::Frame,
    row: u32,
    col: u32,
    spans: *const SpanRec,
    span_count: u32,
) -> i64 {
    let f = match as_frame_mut(handle) {
        Some(f) => f,
        None => return -1,
    };
    if span_count == 0 {
        return 0;
    }
    if spans.is_null() {
        return -1;
    }
    let slice = unsafe { std::slice::from_raw_parts(spans, span_count as usize) };
    f.write_line(row, col, slice);
    0
}

/// Borrow helper used by diff.rs.
pub(crate) fn frame_ref<'a>(handle: *const crate::abi::Frame) -> Option<&'a Frame> {
    if handle.is_null() {
        return None;
    }
    unsafe { Some(&*handle) }
}

// keep the abi re-export type referenced for rustdoc clarity
const _: () = ();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::abi::{color_named16, color_rgb, ATTR_BOLD};

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

    #[test]
    fn create_and_dims() {
        let f = Frame::new(10, 4).unwrap();
        assert_eq!(f.w, 10);
        assert_eq!(f.h, 4);
        assert_eq!(f.cells.len(), 40);
        // default blank is a space
        assert_eq!(f.cluster_bytes(0, 0), b" ");
    }

    #[test]
    fn rejects_absurd_dims() {
        assert!(Frame::new(0, 10).is_none());
        assert!(Frame::new(10, 0).is_none());
        assert!(Frame::new(2000, 2000).is_none()); // 4_000_000 > 1_000_000
    }

    #[test]
    fn write_simple_line() {
        let mut f = Frame::new(10, 2).unwrap();
        f.write_line(0, 0, &[span("hi", color_default(), color_default(), 0)]);
        assert_eq!(f.cluster_bytes(0, 0), b"h");
        assert_eq!(f.cluster_bytes(0, 1), b"i");
        // rest of row remains blank
        assert_eq!(f.cluster_bytes(0, 2), b" ");
    }

    #[test]
    fn write_wide_cluster_sets_continuation() {
        let mut f = Frame::new(10, 1).unwrap();
        f.write_line(0, 0, &[span("中", color_default(), color_default(), 0)]);
        assert_eq!(f.cluster_bytes(0, 0), "中".as_bytes());
        assert!(f.cell(0, 1).continuation);
        assert_eq!(f.cluster_bytes(0, 1), b""); // continuation has no text
    }

    #[test]
    fn clip_drops_wide_at_edge() {
        // width 3, write "a中" → a at col0, 中 needs cols 1..3 (fits exactly 2)
        let mut f = Frame::new(3, 1).unwrap();
        f.write_line(0, 0, &[span("a中", color_default(), color_default(), 0)]);
        assert_eq!(f.cluster_bytes(0, 0), b"a");
        assert_eq!(f.cluster_bytes(0, 1), "中".as_bytes());
        assert!(f.cell(0, 2).continuation);
        // now "a中b" — b would land at col3 == w, dropped
        let mut f2 = Frame::new(3, 1).unwrap();
        f2.write_line(0, 0, &[span("a中b", color_default(), color_default(), 0)]);
        assert_eq!(f2.cluster_bytes(0, 0), b"a");
        assert_eq!(f2.cluster_bytes(0, 1), "中".as_bytes());
        assert!(f2.cell(0, 2).continuation);
    }

    #[test]
    fn clip_blanks_leftover_single_cell() {
        // width 2, write "中" at col0: needs 2 cols, fits. Then nothing.
        // width 1, write "中": 1 cell remains, wide dropped, cell blanked.
        let mut f = Frame::new(1, 1).unwrap();
        f.clear();
        // pre-place content to verify blanking
        f.cells[0] = Cell::with_cluster(b"x", color_default(), color_default(), 0, &mut f.spills);
        f.write_line(0, 0, &[span("中", color_default(), color_default(), 0)]);
        assert_eq!(f.cluster_bytes(0, 0), b" "); // blanked
    }

    #[test]
    fn spill_for_long_zwj_family() {
        let mut f = Frame::new(40, 1).unwrap();
        // 👨‍👩‍👧‍👦 = 25 bytes > 8 → spills
        let s = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}";
        f.write_line(0, 0, &[span(s, color_default(), color_default(), 0)]);
        assert_eq!(f.cluster_bytes(0, 0), s.as_bytes());
        assert_eq!(f.spills.len(), 1);
        assert!(f.cell(0, 1).continuation);
    }

    #[test]
    fn clear_resets_cells() {
        let mut f = Frame::new(4, 1).unwrap();
        f.write_line(
            0,
            0,
            &[span("ab", color_rgb(1, 1, 1), color_default(), ATTR_BOLD)],
        );
        f.clear();
        assert_eq!(f.cluster_bytes(0, 0), b" ");
        assert_eq!(f.cell(0, 0).fg, color_default());
        assert_eq!(f.cell(0, 0).attrs, 0);
    }

    #[test]
    fn resize_preserves_overlap() {
        let mut f = Frame::new(4, 2).unwrap();
        f.write_line(0, 0, &[span("abcd", color_default(), color_default(), 0)]);
        f.resize(2, 2);
        assert_eq!(f.w, 2);
        assert_eq!(f.cluster_bytes(0, 0), b"a");
        assert_eq!(f.cluster_bytes(0, 1), b"b");
        // row 1 cleared
        assert_eq!(f.cluster_bytes(1, 0), b" ");
    }

    #[test]
    fn style_inherited_by_continuation() {
        let mut f = Frame::new(5, 1).unwrap();
        f.write_line(
            0,
            0,
            &[span("中", color_named16(2), color_named16(4), ATTR_BOLD)],
        );
        assert_eq!(f.cell(0, 1).fg, color_named16(2));
        assert_eq!(f.cell(0, 1).bg, color_named16(4));
        assert_eq!(f.cell(0, 1).attrs, ATTR_BOLD);
    }

    #[test]
    fn write_line_noop_out_of_bounds() {
        let mut f = Frame::new(4, 2).unwrap();
        f.write_line(5, 0, &[span("x", color_default(), color_default(), 0)]);
        f.write_line(0, 9, &[span("x", color_default(), color_default(), 0)]);
        // unchanged
        assert_eq!(f.cluster_bytes(0, 0), b" ");
    }
}
