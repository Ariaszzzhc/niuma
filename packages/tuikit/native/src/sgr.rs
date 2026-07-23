//! SGR emission + RGB color quantization (hand-written, zero crates).
//!
//! Color model mirrors [`crate::abi`]: colors are tagged `u32` words
//! (tag in bits 31..30). This module turns a `(fg, bg, attrs)` triple into a
//! self-contained SGR byte sequence beginning with `ESC[0m`, and quantizes
//! 24-bit RGB down to the xterm 256 / named-16 palettes when `caps` forbids
//! truecolor.
//!
//! Quantization uses squared Euclidean distance in RGB space against the
//! canonical xterm 6x6x6 cube (levels `{0,95,135,175,215,255}`) and the
//! 24-step grayscale ramp (`8 + 10*i`). Ties prefer the cube.

use crate::abi::{
    self, color_default, ATTR_BOLD, ATTR_DIM, ATTR_ITALIC, ATTR_REVERSE, ATTR_STRIKETHROUGH,
    ATTR_UNDERLINE, CAP_COLOR_256, CAP_TRUECOLOR, COLOR_TAG_DEFAULT, COLOR_TAG_INDEXED256,
    COLOR_TAG_NAMED16, COLOR_TAG_RGB, COLOR_TAG_SHIFT,
};

// ---------------------------------------------------------------------------
// xterm palette geometry
// ---------------------------------------------------------------------------

/// The six signal levels of the xterm 6x6x6 color cube.
const CUBE_LEVELS: [u8; 6] = [0, 95, 135, 175, 215, 255];

/// Index in `CUBE_LEVELS` of the nearest level for one channel (squared dist).
fn nearest_cube_level(channel: u8) -> u8 {
    let mut best = 0u8;
    let mut best_d = u32::MAX;
    for (i, &lvl) in CUBE_LEVELS.iter().enumerate() {
        let d = (channel as i32 - lvl as i32).abs() as u32;
        let d = d * d;
        if d < best_d {
            best_d = d;
            best = i as u8;
        }
    }
    best
}

/// Squared RGB distance between `(r,g,b)` and a target `(tr,tg,tb)`.
fn dist2(r: u8, g: u8, b: u8, tr: u8, tg: u8, tb: u8) -> u32 {
    let dr = r as i32 - tr as i32;
    let dg = g as i32 - tg as i32;
    let db = b as i32 - tb as i32;
    (dr * dr + dg * dg + db * db) as u32
}

/// Quantize RGB → xterm-256 index (16..255). Cube = 16..231, ramp = 232..255.
/// Ties prefer the cube (strict `<` when comparing ramp candidate).
pub fn rgb_to_256(r: u8, g: u8, b: u8) -> u8 {
    // Cube candidate.
    let ri = nearest_cube_level(r) as u32;
    let gi = nearest_cube_level(g) as u32;
    let bi = nearest_cube_level(b) as u32;
    let cube_idx = 16 + 36 * ri + 6 * gi + bi;
    let cube_idx = cube_idx as u8;
    let tr = CUBE_LEVELS[ri as usize];
    let tg = CUBE_LEVELS[gi as usize];
    let tb = CUBE_LEVELS[bi as usize];
    let cube_d = dist2(r, g, b, tr, tg, tb);

    // Grayscale ramp candidate.
    let gray = gray_representative(r, g, b);
    let mut best_gray = 232u8;
    let mut best_gray_d = u32::MAX;
    for i in 0..24u32 {
        let lvl = (8 + 10 * i) as u8;
        let d = dist2(r, g, b, lvl, lvl, lvl);
        if d < best_gray_d {
            best_gray_d = d;
            best_gray = (232 + i) as u8;
        }
    }
    let _ = gray; // (kept for clarity; ramp search above is authoritative)

    if best_gray_d < cube_d {
        best_gray
    } else {
        cube_idx
    }
}

/// Nearest single gray level — helper retained for introspection / tests.
fn gray_representative(r: u8, g: u8, b: u8) -> u8 {
    let l = ((r as u32 + g as u32 + b as u32) / 3) as u8;
    let mut best = 8u8;
    let mut best_d = u32::MAX;
    for i in 0..24u32 {
        let lvl = (8 + 10 * i) as u8;
        let d = (l as i32 - lvl as i32).unsigned_abs();
        let d = d * d;
        if d < best_d {
            best_d = d;
            best = lvl;
        }
    }
    best
}

// ---------------------------------------------------------------------------
// Named-16 palette (standard xterm 16-color table)
// ---------------------------------------------------------------------------

/// The standard xterm 16-color palette as RGB triples (indices 0..15).
#[rustfmt::skip]
static NAMED16: [(u8, u8, u8); 16] = [
    (0x00, 0x00, 0x00), // 0  black
    (0x80, 0x00, 0x00), // 1  red
    (0x00, 0x80, 0x00), // 2  green
    (0x80, 0x80, 0x00), // 3  yellow
    (0x00, 0x00, 0x80), // 4  blue
    (0x80, 0x00, 0x80), // 5  magenta
    (0x00, 0x80, 0x80), // 6  cyan
    (0xC0, 0xC0, 0xC0), // 7  white (light gray)
    (0x80, 0x80, 0x80), // 8  bright black (dark gray)
    (0xFF, 0x00, 0x00), // 9  bright red
    (0x00, 0xFF, 0x00), // 10 bright green
    (0xFF, 0xFF, 0x00), // 11 bright yellow
    (0x00, 0x00, 0xFF), // 12 bright blue
    (0xFF, 0x00, 0xFF), // 13 bright magenta
    (0x00, 0xFF, 0xFF), // 14 bright cyan
    (0xFF, 0xFF, 0xFF), // 15 bright white
];

/// Quantize RGB → nearest named-16 palette index (0..15).
pub fn rgb_to_16(r: u8, g: u8, b: u8) -> u8 {
    let mut best = 0u8;
    let mut best_d = u32::MAX;
    for (i, &(tr, tg, tb)) in NAMED16.iter().enumerate() {
        let d = dist2(r, g, b, tr, tg, tb);
        if d < best_d {
            best_d = d;
            best = i as u8;
        }
    }
    best
}

// ---------------------------------------------------------------------------
// Color-word decoding helpers
// ---------------------------------------------------------------------------

/// Tag of a color word (top two bits).
pub fn color_tag(word: u32) -> u32 {
    (word >> COLOR_TAG_SHIFT) & 0x3
}

/// RGB payload of an RGB-tagged word.
pub fn color_rgb_channels(word: u32) -> (u8, u8, u8) {
    let r = ((word >> 16) & 0xFF) as u8;
    let g = ((word >> 8) & 0xFF) as u8;
    let b = (word & 0xFF) as u8;
    (r, g, b)
}

/// A color resolved for emission, in the representation the SGR builder wants.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum EmitColor {
    Default,
    Named(u8),
    Indexed256(u8),
    Rgb(u8, u8, u8),
}

/// Resolve a color word to an emission color, quantizing RGB per `caps`.
fn resolve(word: u32, caps: u32) -> EmitColor {
    match color_tag(word) {
        COLOR_TAG_DEFAULT => EmitColor::Default,
        COLOR_TAG_NAMED16 => EmitColor::Named((word & 0xFF) as u8),
        COLOR_TAG_INDEXED256 => {
            // If the terminal cannot do 256, quantize the indexed entry's RGB
            // down to named-16 via the standard palette.
            if caps & CAP_COLOR_256 != 0 {
                EmitColor::Indexed256((word & 0xFF) as u8)
            } else {
                let (r, g, b) = palette256_rgb((word & 0xFF) as u8);
                EmitColor::Named(rgb_to_16(r, g, b))
            }
        }
        COLOR_TAG_RGB => {
            let (r, g, b) = color_rgb_channels(word);
            if caps & CAP_TRUECOLOR != 0 {
                EmitColor::Rgb(r, g, b)
            } else if caps & CAP_COLOR_256 != 0 {
                EmitColor::Indexed256(rgb_to_256(r, g, b))
            } else {
                EmitColor::Named(rgb_to_16(r, g, b))
            }
        }
        _ => EmitColor::Default,
    }
}

/// Look up the RGB of an xterm-256 index (used when downgrading indexed256).
fn palette256_rgb(idx: u8) -> (u8, u8, u8) {
    if idx < 16 {
        NAMED16[idx as usize]
    } else if idx < 232 {
        let i = (idx - 16) as u32;
        let r = CUBE_LEVELS[((i / 36) % 6) as usize];
        let g = CUBE_LEVELS[((i / 6) % 6) as usize];
        let b = CUBE_LEVELS[(i % 6) as usize];
        (r, g, b)
    } else {
        let lvl = 8 + 10 * (idx - 232) as u32;
        (lvl as u8, lvl as u8, lvl as u8)
    }
}

// ---------------------------------------------------------------------------
// SGR sequence construction
// ---------------------------------------------------------------------------

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

/// Append one SGR parameter with a leading separator (`;`).
fn push_param(out: &mut Vec<u8>, p: u32) {
    out.push(b';');
    push_dec(out, p);
}

/// Append an emission color as foreground SGR params (assumes the leading
/// `;` is added by [`push_param`]). `is_fg` selects 3x/4x vs 9x/10x ranges.
fn push_color_params(out: &mut Vec<u8>, c: EmitColor, is_fg: bool) {
    match c {
        EmitColor::Default => {
            // 39 (fg default) / 49 (bg default)
            push_param(out, if is_fg { 39 } else { 49 });
        }
        EmitColor::Named(idx) => {
            // 30..37 normal, 90..97 bright (idx 8..15)
            let base = if is_fg { 30 } else { 40 };
            if idx < 8 {
                push_param(out, base + idx as u32);
            } else {
                push_param(out, base + 60 + (idx as u32 - 8));
            }
        }
        EmitColor::Indexed256(idx) => {
            // 38;5;n  /  48;5;n
            push_param(out, if is_fg { 38 } else { 48 });
            push_param(out, 5);
            push_param(out, idx as u32);
        }
        EmitColor::Rgb(r, g, b) => {
            push_param(out, if is_fg { 38 } else { 48 });
            push_param(out, 2);
            push_param(out, r as u32);
            push_param(out, g as u32);
            push_param(out, b as u32);
        }
    }
}

/// Build a complete self-contained SGR sequence for `(fg, bg, attrs)`:
/// a SINGLE `ESC[ ... m` whose first param is `0` (reset), followed by the
/// minimal params for the active attributes/colors, all `;`-separated —
/// e.g. `ESC[0;1;38;2;122;180;255m`. NOTE: an earlier revision emitted
/// `ESC[0m` followed by `;`-prefixed params, producing the non-standard
/// `ESC[0m;1;...m`; terminals that parse SGR strictly (tmux, screen, some
/// VTE builds) then dropped the leading `ESC[` of the *following* sequence
/// and printed the raw `;1;38;2;...m` text — the "no colors, garbage on
/// screen" bug. One CSI, params separated, is the only portable form.
pub fn build_sgr(fg: u32, bg: u32, attrs: u16, caps: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(32);
    out.extend_from_slice(b"\x1b[0");
    // We always begin from a reset, so emit only the active attributes / colors.
    if attrs & ATTR_BOLD != 0 {
        push_param(&mut out, 1);
    }
    if attrs & ATTR_DIM != 0 {
        push_param(&mut out, 2);
    }
    if attrs & ATTR_ITALIC != 0 {
        push_param(&mut out, 3);
    }
    if attrs & ATTR_UNDERLINE != 0 {
        push_param(&mut out, 4);
    }
    if attrs & ATTR_REVERSE != 0 {
        push_param(&mut out, 7);
    }
    if attrs & ATTR_STRIKETHROUGH != 0 {
        push_param(&mut out, 9);
    }
    let fc = resolve(fg, caps);
    let bc = resolve(bg, caps);
    // Only emit a color param if it is non-default (default is covered by 0m).
    if fc != EmitColor::Default {
        push_color_params(&mut out, fc, true);
    }
    if bc != EmitColor::Default {
        push_color_params(&mut out, bc, false);
    }
    out.push(b'm');
    out
}

/// Linear interpolation of two RGB-tagged color words at factor `t` in 0..=255.
/// Returns the interpolated RGB-tagged word.
pub fn lerp_rgb(from: u32, to: u32, t: u32) -> u32 {
    let (r0, g0, b0) = color_rgb_channels(from);
    let (r1, g1, b1) = color_rgb_channels(to);
    // t is 0..=255. Signed delta math: to may be below from on any channel.
    let lerp = |a: u8, b: u8| -> u8 {
        let a = a as i32;
        let b = b as i32;
        (a + (b - a) * (t as i32) / 255).clamp(0, 255) as u8
    };
    let r = lerp(r0, r1);
    let g = lerp(g0, g1);
    let b = lerp(b0, b1);
    abi::color_rgb(r, g, b)
}

// ---------------------------------------------------------------------------
// FFI implementations (called from abi.rs)
// ---------------------------------------------------------------------------

/// Write the SGR sequence into `out` (min(total, cap)); return total bytes.
pub(crate) fn sgr_style_impl(fg: u32, bg: u32, attrs: u16, caps: u32, out: *mut u8, cap: u32) -> i64 {
    let bytes = build_sgr(fg, bg, attrs, caps);
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

pub(crate) fn rgb_to_256_impl(r: u8, g: u8, b: u8) -> i64 {
    rgb_to_256(r, g, b) as i64
}

pub(crate) fn rgb_to_16_impl(r: u8, g: u8, b: u8) -> i64 {
    rgb_to_16(r, g, b) as i64
}

/// Paint `text` with a horizontal gradient; one `GradSpanRec` per cluster.
/// `from_rgb` / `to_rgb` MUST be RGB-tagged words.
pub(crate) fn gradient_impl(
    from_rgb: u32,
    to_rgb: u32,
    text: *const u8,
    len: u32,
    bg: u32,
    caps: u32,
    out: *mut u8,
    cap: u32,
) -> i64 {
    if color_tag(from_rgb) != COLOR_TAG_RGB || color_tag(to_rgb) != COLOR_TAG_RGB {
        return -1;
    }
    if text.is_null() {
        return -1;
    }
    let bytes = unsafe { std::slice::from_raw_parts(text, len as usize) };
    let s = match std::str::from_utf8(bytes) {
        Ok(s) => s,
        Err(_) => return -1,
    };
    let clusters = crate::width::grapheme_spans(s);
    let n = clusters.len();
    if n == 0 {
        return 0;
    }
    let total = n * abi::GRAD_SPAN_REC_SIZE;
    if total == 0 {
        return 0;
    }
    if out.is_null() {
        return if cap == 0 { 0 } else { -1 };
    }
    // Build records into a temp buffer, then copy min(total, cap).
    let mut recs: Vec<u8> = Vec::with_capacity(total);
    for (i, g) in clusters.iter().enumerate() {
        let t = if n == 1 { 0 } else { (i * 255 / (n - 1)) as u32 };
        let rgb_word = lerp_rgb(from_rgb, to_rgb, t);
        let fg_word = match caps & (CAP_TRUECOLOR | CAP_COLOR_256) {
            CAP_TRUECOLOR => rgb_word,
            _ if caps & CAP_TRUECOLOR != 0 => rgb_word,
            _ if caps & CAP_COLOR_256 != 0 => {
                let (r, gg, b) = color_rgb_channels(rgb_word);
                abi::color_indexed256(rgb_to_256(r, gg, b))
            }
            _ => {
                let (r, gg, b) = color_rgb_channels(rgb_word);
                abi::color_named16(rgb_to_16(r, gg, b))
            }
        };
        let mut rec = [0u8; abi::GRAD_SPAN_REC_SIZE];
        rec[0..4].copy_from_slice(&(g.start as u32).to_le_bytes());
        rec[4..8].copy_from_slice(&((g.end - g.start) as u32).to_le_bytes());
        rec[8..12].copy_from_slice(&fg_word.to_le_bytes());
        rec[12..16].copy_from_slice(&bg.to_le_bytes());
        recs.extend_from_slice(&rec);
    }
    let ncopy = (total as u32).min(cap) as usize;
    // Copy whole records only; never write a partial record (TS reads 16B units).
    let ncopy = (ncopy / abi::GRAD_SPAN_REC_SIZE) * abi::GRAD_SPAN_REC_SIZE;
    if ncopy > 0 {
        unsafe {
            std::ptr::copy_nonoverlapping(recs.as_ptr(), out, ncopy);
        }
    }
    total as i64
}

// keep imports referenced
const _: u32 = color_default();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::abi::{color_indexed256, color_named16, color_rgb, GRAD_SPAN_REC_SIZE};

    #[test]
    fn pure_red_is_196_or_1() {
        // (255,0,0): cube 196 exactly; ramp farther.
        assert_eq!(rgb_to_256(255, 0, 0), 196);
        assert_eq!(rgb_to_16(255, 0, 0), 9); // bright red
    }

    #[test]
    fn white_is_231_or_15() {
        assert_eq!(rgb_to_256(255, 255, 255), 231); // top of cube
        assert_eq!(rgb_to_16(255, 255, 255), 15);
    }

    #[test]
    fn black_is_16() {
        assert_eq!(rgb_to_256(0, 0, 0), 16);
        assert_eq!(rgb_to_16(0, 0, 0), 0);
    }

    #[test]
    fn gray_808080() {
        // 0x80 = 128. Nearest gray ramp level: 8+10*12=128 → idx 232+12=244.
        assert_eq!(rgb_to_256(0x80, 0x80, 0x80), 244);
    }

    #[test]
    fn gray_333333() {
        // 0x33=51. ramp: 8+10*4=48 (idx 236), cube gray not a single level.
        // distance 51->48 = 9; cube combos all farther. Expect 236.
        assert_eq!(rgb_to_256(0x33, 0x33, 0x33), 236);
    }

    #[test]
    fn sgr_truecolor_rgb() {
        let caps = CAP_TRUECOLOR;
        let fg = color_rgb(1, 2, 3);
        let s = build_sgr(fg, color_default(), 0, caps);
        // ESC[0 ; 38;2;1;2;3 m — one CSI, `;`-separated params
        assert_eq!(s, b"\x1b[0;38;2;1;2;3m".to_vec());
    }

    #[test]
    fn sgr_attrs_bold_underline() {
        let s = build_sgr(
            color_default(),
            color_default(),
            ATTR_BOLD | ATTR_UNDERLINE,
            CAP_TRUECOLOR,
        );
        assert_eq!(s, b"\x1b[0;1;4m".to_vec());
    }

    #[test]
    fn sgr_256_quantize() {
        // RGB (255,0,0) under 256 caps → 38;5;196
        let s = build_sgr(color_rgb(255, 0, 0), color_default(), 0, CAP_COLOR_256);
        assert_eq!(s, b"\x1b[0;38;5;196m".to_vec());
    }

    #[test]
    fn sgr_16_quantize() {
        // rgb(255,0,0) under 0 caps → named16 idx 9 (bright red) = SGR 91.
        let s = build_sgr(color_rgb(255, 0, 0), color_default(), 0, 0);
        assert_eq!(s, b"\x1b[0;91m".to_vec()); // bright red fg
    }

    #[test]
    fn sgr_named_and_bg() {
        let s = build_sgr(
            color_named16(2),          // green fg = 32
            color_named16(11),         // bright yellow bg = 103
            ATTR_REVERSE | ATTR_STRIKETHROUGH,
            CAP_TRUECOLOR,
        );
        assert_eq!(s, b"\x1b[0;7;9;32;103m".to_vec());
    }

    #[test]
    fn gradient_endpoints_truecolor() {
        let from = color_rgb(0, 0, 0);
        let to = color_rgb(255, 255, 255);
        let text = "abc"; // 3 clusters
        let mut buf = [0u8; GRAD_SPAN_REC_SIZE * 3];
        let total = gradient_impl(
            from,
            to,
            text.as_ptr(),
            text.len() as u32,
            color_default(),
            CAP_TRUECOLOR,
            buf.as_mut_ptr(),
            buf.len() as u32,
        );
        assert_eq!(total, (GRAD_SPAN_REC_SIZE * 3) as i64);
        // cluster 0 → from (0,0,0); cluster 2 → to (255,255,255)
        let f0 = u32::from_le_bytes([
            buf[8], buf[9], buf[10], buf[11],
        ]);
        let f2 = u32::from_le_bytes([
            buf[8 + 2 * GRAD_SPAN_REC_SIZE],
            buf[9 + 2 * GRAD_SPAN_REC_SIZE],
            buf[10 + 2 * GRAD_SPAN_REC_SIZE],
            buf[11 + 2 * GRAD_SPAN_REC_SIZE],
        ]);
        assert_eq!(color_tag(f0), COLOR_TAG_RGB);
        assert_eq!(color_rgb_channels(f0), (0, 0, 0));
        assert_eq!(color_rgb_channels(f2), (255, 255, 255));
    }

    #[test]
    fn gradient_single_cluster_uses_from() {
        let from = color_rgb(10, 20, 30);
        let to = color_rgb(200, 200, 200);
        let text = "X";
        let mut buf = [0u8; GRAD_SPAN_REC_SIZE];
        let total = gradient_impl(
            from,
            to,
            text.as_ptr(),
            text.len() as u32,
            color_default(),
            CAP_TRUECOLOR,
            buf.as_mut_ptr(),
            buf.len() as u32,
        );
        assert_eq!(total, GRAD_SPAN_REC_SIZE as i64);
        let f0 = u32::from_le_bytes([buf[8], buf[9], buf[10], buf[11]]);
        assert_eq!(color_rgb_channels(f0), (10, 20, 30));
    }

    #[test]
    fn gradient_rejects_non_rgb() {
        let r = gradient_impl(
            color_named16(0),
            color_rgb(0, 0, 0),
            b"x".as_ptr(),
            1,
            color_default(),
            CAP_TRUECOLOR,
            std::ptr::null_mut(),
            0,
        );
        assert_eq!(r, -1);
    }

    #[test]
    fn indexed256_downgrades_to_named_when_no_256_cap() {
        // idx 196 = (255,0,0) → named16 bright red (9) = SGR 91 under 0 caps.
        let s = build_sgr(color_indexed256(196), color_default(), 0, 0);
        assert_eq!(s, b"\x1b[0;91m".to_vec());
    }

    #[test]
    fn lerp_midpoint() {
        let m = lerp_rgb(color_rgb(0, 0, 0), color_rgb(100, 200, 255), 128);
        // approx half: 0 + 100*128/255 ≈ 50; 200*128/255≈100; 255*128/255=128
        let (r, g, b) = color_rgb_channels(m);
        assert!((45..=55).contains(&r));
        assert!((95..=105).contains(&g));
        assert!(b == 128 || b == 127 || b == 129);
    }
}
