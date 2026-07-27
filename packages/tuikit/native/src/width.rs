//! Display-width + minimal grapheme clustering (hand-written, no unicode crates).
//!
//! Width model (covers CJK / European / emoji, the cases the tests and the TUI
//! exercise):
//! - **Wide (2 cells):** an embedded sorted interval table covering CJK
//!   Unified Ideographs + extensions, Hiragana/Katakana, Hangul, Bopomofo,
//!   CJK compat/punctuation, fullwidth forms, and the emoji blocks
//!   (`1F000–1FAFF`, `2600–27BF` and the EAW=W symbol ranges). A leading
//!   `U+200D` ZWJ chain / `U+FE0F` VS16 / emoji-modifier sequence forces its
//!   whole cluster to width 2 (see [`grapheme_spans`]).
//! - **Zero width (0 cells):** combining diacriticals / marks (Mn, Me),
//!   format chars (Cf: ZWJ/ZWNJ/soft-hyphen/BOM/directional), variation
//!   selectors (`FE00–FE0F`, `E0100–E01EF`) and emoji skin-tone modifiers
//!   (`1F3FB–1F3FF`). Control chars (Cc: `0000–001F`, `007F–009F`) are also 0.
//! - **Everything else:** 1 cell.
//!
//! Coverage note: the combining-mark table includes the common
//! Latin/Cyrillic/Hebrew/Arabic/Thai/Indic ranges but is not an exhaustive
//! Unicode Mn/Me mirror; exotic combining marks may report width 1. The
//! astral emoji blocks are treated as wide per the contract.

use crate::abi;

// ---------------------------------------------------------------------------
// Tables — sorted, non-overlapping `(start, end)` inclusive intervals.
// ---------------------------------------------------------------------------

/// Intervals that render two cells wide. Sorted ascending; binary-searched.
#[rustfmt::skip]
static WIDE: &[(u32, u32)] = &[
    (0x1100, 0x115F),   // Hangul Jamo
    (0x231A, 0x231B),   // ⌚ ⌛  (EAW W)
    (0x2329, 0x232A),   // 〈 〉 (EAW W)
    (0x23E9, 0x23EC),   // ⏩ ⏭
    (0x23F0, 0x23F0),   // ⏰
    (0x23F3, 0x23F3),   // ⏳
    (0x25FD, 0x25FE),   // ◽ ◾
    (0x2614, 0x2615),   // ☔ ☕
    (0x2648, 0x2653),   // ♈–♓
    (0x267F, 0x267F),   // ♿
    (0x2693, 0x2693),   // ⚓
    (0x26A1, 0x26A1),   // ⚡
    (0x26AA, 0x26AB),
    (0x26BD, 0x26BE),
    (0x26C4, 0x26C5),
    (0x26CE, 0x26CE),
    (0x26D4, 0x26D4),
    (0x26EA, 0x26EA),
    (0x26F2, 0x26F3),
    (0x26F5, 0x26F5),
    (0x26FA, 0x26FA),
    (0x26FD, 0x26FD),
    (0x2705, 0x2705),
    (0x270A, 0x270B),
    (0x2728, 0x2728),
    (0x274C, 0x274C),
    (0x274E, 0x274E),
    (0x2753, 0x2755),
    (0x2757, 0x2757),
    (0x2795, 0x2797),
    (0x27B0, 0x27B0),
    (0x27BF, 0x27BF),
    (0x2B1B, 0x2B1C),
    (0x2B50, 0x2B50),
    (0x2B55, 0x2B55),
    // CJK radicals → CJK compat (broad EAW W block)
    (0x2E80, 0x303E),
    (0x3041, 0x33FF),   // Hiragana/Katakana/Bopomofo/Hangul-jamo/Kanbun/enclosed/compat
    (0x3400, 0x4DBF),   // CJK Unified Ideographs Extension A
    (0x4E00, 0x9FFF),   // CJK Unified Ideographs (BMP)
    (0xA000, 0xA4CF),   // Yi syllables / radicals
    (0xA960, 0xA97F),   // Hangul Jamo Extended-A
    (0xAC00, 0xD7A3),   // Hangul Syllables
    (0xF900, 0xFAFF),   // CJK Compatibility Ideographs
    (0xFE10, 0xFE19),   // Vertical Forms
    (0xFE30, 0xFE6F),   // CJK Compatibility Forms
    (0xFF01, 0xFF60),   // Fullwidth ASCII / signs
    (0xFFE0, 0xFFE6),   // Fullwidth ￠￡￥￦…
    // Astral emoji blocks (treated wide per spec). Regional indicators
    // 1F1E6–1F1FF live here too; char_width gives each RI width 2, while
    // grapheme clustering pairs consecutive RIs into one 2-cell cluster.
    (0x1F000, 0x1F0FF), // Mahjong / playing cards
    (0x1F100, 0x1F1FF), // enclosed / regional indicators
    (0x1F200, 0x1F320),
    (0x1F324, 0x1F5FF), // pictographs (skipping 1F321–1F323 rain region handled by 1F300-1F320 above? keep contiguous below)
    // NOTE: the two ranges above leave a small gap; merged cleanly below.
];

// The emoji block is more cleanly one contiguous span; redefine without the
// awkward gap. (Kept separate from the curated BMP list for readability.)
#[rustfmt::skip]
static WIDE_ASTRAL: &[(u32, u32)] = &[
    (0x1F000, 0x1FAFF), // all astral emoji blocks incl. regional indicators
];

/// Intervals that render zero cells wide (combining marks + format chars).
/// Emoji skin-tone modifiers (`1F3FB–1F3FF`) are also zero-width extenders.
#[rustfmt::skip]
static ZERO_WIDTH: &[(u32, u32)] = &[
    (0x00AD, 0x00AD),   // soft hyphen (Cf)
    (0x0300, 0x036F),   // Combining Diacritical Marks  (e + accent lives here)
    (0x0483, 0x0489),   // Cyrillic combining
    (0x0591, 0x05BD),   // Hebrew points
    (0x05BF, 0x05BF),
    (0x05C1, 0x05C2),
    (0x05C4, 0x05C5),
    (0x05C7, 0x05C7),
    (0x0610, 0x061A),   // Arabic
    (0x064B, 0x065F),
    (0x0670, 0x0670),
    (0x06D6, 0x06DC),
    (0x06DF, 0x06E4),
    (0x06E7, 0x06E8),
    (0x06EA, 0x06ED),
    (0x0711, 0x0711),
    (0x0730, 0x074A),
    (0x07A6, 0x07B0),
    (0x07EB, 0x07F3),
    (0x07FD, 0x07FD),
    (0x0816, 0x0819),
    (0x081B, 0x0823),
    (0x0825, 0x0827),
    (0x0829, 0x082D),
    (0x0859, 0x085B),
    (0x08D3, 0x08E1),
    (0x08E3, 0x0903),   // Arabic/Devanagari combining tail
    (0x093A, 0x093C),
    (0x093E, 0x094F),
    (0x0951, 0x0957),
    (0x0962, 0x0963),
    (0x0981, 0x0983),
    (0x09BC, 0x09BC),
    (0x09BE, 0x09C4),
    (0x09C7, 0x09C8),
    (0x09CB, 0x09CD),
    (0x09D7, 0x09D7),
    (0x09E2, 0x09E3),
    (0x09FE, 0x09FE),
    (0x0A01, 0x0A03),
    (0x0A3C, 0x0A3C),
    (0x0A3E, 0x0A42),
    (0x0A47, 0x0A48),
    (0x0A4B, 0x0A4D),
    (0x0A51, 0x0A51),
    (0x0A70, 0x0A71),
    (0x0A75, 0x0A75),
    (0x0A81, 0x0A83),
    (0x0ABC, 0x0ABC),
    (0x0ABE, 0x0AC5),
    (0x0AC7, 0x0AC8),
    (0x0ACD, 0x0ACD),
    (0x0AE2, 0x0AE3),
    (0x0AFA, 0x0AFF),
    (0x0B01, 0x0B01),
    (0x0B3C, 0x0B3C),
    (0x0B3E, 0x0B44),
    (0x0B47, 0x0B48),
    (0x0B4B, 0x0B4D),
    (0x0B55, 0x0B57),
    (0x0B62, 0x0B63),
    (0x0B82, 0x0B82),
    (0x0BBE, 0x0BC2),
    (0x0BC6, 0x0BC8),
    (0x0BCA, 0x0BCD),
    (0x0BD7, 0x0BD7),
    (0x0C00, 0x0C04),
    (0x0C3E, 0x0C44),
    (0x0C46, 0x0C48),
    (0x0C4A, 0x0C4D),
    (0x0C55, 0x0C56),
    (0x0C62, 0x0C63),
    (0x0C81, 0x0C81),
    (0x0CBC, 0x0CBC),
    (0x0CBE, 0x0CC4),
    (0x0CC6, 0x0CC8),
    (0x0CCA, 0x0CCD),
    (0x0CD5, 0x0CD6),
    (0x0CE2, 0x0CE3),
    (0x0D00, 0x0D03),
    (0x0D3B, 0x0D3C),
    (0x0D3E, 0x0D44),
    (0x0D46, 0x0D48),
    (0x0D4A, 0x0D4D),
    (0x0D57, 0x0D57),
    (0x0D62, 0x0D63),
    (0x0D81, 0x0D81),
    (0x0DCA, 0x0DCA),
    (0x0DCF, 0x0DD4),
    (0x0DD6, 0x0DD6),
    (0x0DD8, 0x0DDF),
    (0x0DF2, 0x0DF3),
    (0x0E31, 0x0E31),
    (0x0E34, 0x0E3A),
    (0x0E47, 0x0E4E),
    (0x0EB1, 0x0EB1),
    (0x0EB4, 0x0EBC),
    (0x0EC8, 0x0ECD),
    (0x0F18, 0x0F19),
    (0x0F35, 0x0F35),
    (0x0F37, 0x0F37),
    (0x0F39, 0x0F39),
    (0x0F3E, 0x0F3F),
    (0x0F71, 0x0F84),
    (0x0F86, 0x0F87),
    (0x0F8D, 0x0F97),
    (0x0F99, 0x0FBC),
    (0x0FC6, 0x0FC6),
    (0x102B, 0x103E),
    (0x1056, 0x1059),
    (0x105E, 0x1060),
    (0x1062, 0x1064),
    (0x1067, 0x106D),
    (0x1071, 0x1074),
    (0x1082, 0x108D),
    (0x108F, 0x108F),
    (0x109A, 0x109D),
    (0x135D, 0x135F),
    (0x1712, 0x1714),
    (0x1732, 0x1734),
    (0x1752, 0x1753),
    (0x1772, 0x1773),
    (0x17B4, 0x17D3),
    (0x17DD, 0x17DD),
    (0x180B, 0x180F),   // variation selectors (Mongolian) / ZWJ-nb
    (0x1885, 0x1886),
    (0x18A9, 0x18A9),
    (0x1920, 0x192B),
    (0x1930, 0x193B),
    (0x1A17, 0x1A1B),
    (0x1A55, 0x1A5E),
    (0x1A60, 0x1A7C),
    (0x1A7F, 0x1A7F),
    (0x1AB0, 0x1ABE),
    (0x1B00, 0x1B04),
    (0x1B34, 0x1B44),
    (0x1B6B, 0x1B73),
    (0x1B80, 0x1B82),
    (0x1BA1, 0x1BAD),
    (0x1BE6, 0x1BF3),
    (0x1C24, 0x1C37),
    (0x1CD0, 0x1CD2),
    (0x1CD4, 0x1CE8),
    (0x1CED, 0x1CED),
    (0x1CF4, 0x1CF4),
    (0x1CF7, 0x1CF9),
    (0x1DC0, 0x1DFF),   // combining diacriticals supplement
    (0x200B, 0x200F),   // ZWSP / ZWNJ / ZWJ / LRM / RLM  (Cf)
    (0x202A, 0x202E),   // bidi controls (Cf)
    (0x2060, 0x2064),   // word joiner etc. (Cf)
    (0x2066, 0x206F),   // bidi isolate (Cf)
    (0x20D0, 0x20F0),   // combining marks for symbols
    (0x2CEF, 0x2CF1),
    (0x2D7F, 0x2D7F),
    (0x2DE0, 0x2DFF),
    (0x302A, 0x302F),
    (0x3099, 0x309A),
    (0xA66F, 0xA672),
    (0xA674, 0xA67D),
    (0xA69E, 0xA69F),
    (0xA6F0, 0xA6F1),
    (0xA802, 0xA802),
    (0xA806, 0xA806),
    (0xA80B, 0xA80B),
    (0xA823, 0xA827),
    (0xA82C, 0xA82C),
    (0xA880, 0xA881),
    (0xA8B4, 0xA8C5),
    (0xA8E0, 0xA8F1),
    (0xA8FF, 0xA8FF),
    (0xA926, 0xA92D),
    (0xA947, 0xA953),
    (0xA980, 0xA983),
    (0xA9B3, 0xA9C0),
    (0xA9E5, 0xA9E5),
    (0xAA29, 0xAA36),
    (0xAA43, 0xAA43),
    (0xAA4C, 0xAA4D),
    (0xAA7B, 0xAA7D),
    (0xAAB0, 0xAAB0),
    (0xAAB2, 0xAAB4),
    (0xAAB7, 0xAAB8),
    (0xAABE, 0xAABF),
    (0xAAC1, 0xAAC1),
    (0xAAEB, 0xAAEF),
    (0xAAF5, 0xAAF6),
    (0xABE3, 0xABEA),
    (0xABEC, 0xABED),
    (0xFB1E, 0xFB1E),
    (0xFE00, 0xFE0F),   // Variation Selectors 1–16 (VS15/VS16)
    (0xFE20, 0xFE2F),   // combining half marks
    (0xFEFF, 0xFEFF),   // BOM (Cf)
    (0x1F3FB, 0x1F3FF), // emoji skin-tone modifiers (extenders)
    (0xE0001, 0xE0001), // language tag (Cf)
    (0xE0020, 0xE007F), // tag block (Cf)
    (0xE0100, 0xE01EF), // Variation Selectors 17–256
];

/// Binary search a sorted, non-overlapping interval table.
fn in_table(table: &[(u32, u32)], cp: u32) -> bool {
    let mut lo = 0usize;
    let mut hi = table.len();
    while lo < hi {
        let mid = (lo + hi) / 2;
        let (s, e) = table[mid];
        if cp < s {
            hi = mid;
        } else if cp > e {
            lo = mid + 1;
        } else {
            return true;
        }
    }
    false
}

/// Display width of a single codepoint (no grapheme context).
pub fn char_width(c: char) -> u32 {
    let cp = c as u32;
    if cp == 0 {
        return 0;
    }
    if in_table(ZERO_WIDTH, cp) {
        return 0;
    }
    // Cc control chars (incl. CR/LF/TAB/DEL/C1) → 0.
    if cp < 0x20 || (0x7F..=0x9F).contains(&cp) {
        return 0;
    }
    if in_table(WIDE, cp) || in_table(WIDE_ASTRAL, cp) {
        return 2;
    }
    1
}

fn is_regional_indicator(cp: u32) -> bool {
    (0x1F1E6..=0x1F1FF).contains(&cp)
}
fn is_variation_selector(cp: u32) -> bool {
    (0xFE00..=0xFE0F).contains(&cp) || (0xE0100..=0xE01EF).contains(&cp)
}
fn is_skin_tone(cp: u32) -> bool {
    (0x1F3FB..=0x1F3FF).contains(&cp)
}
const ZWJ: u32 = 0x200D;
const VS16: u32 = 0xFE0F;
const VS15: u32 = 0xFE0E;

/// One grapheme cluster span: `[start, end)` byte range within the source
/// `&str`, plus its display width.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Grapheme {
    pub start: usize,
    pub end: usize,
    pub width: u32,
}

/// Segment a valid UTF-8 `&str` into grapheme clusters (minimal hand-written
/// rules):
/// - a base codepoint followed by any run of combining marks / variation
///   selectors / skin-tone modifiers;
/// - `emoji (ZWJ emoji)*` chains → one cluster, width 2;
/// - a base + `VS16` → width 2 (emoji presentation); base + `VS15` → width 1
///   (text presentation);
/// - two consecutive Regional Indicators → one flag cluster, width 2.
pub fn grapheme_spans(s: &str) -> Vec<Grapheme> {
    // Collect codepoints with their byte offsets up-front; clustering then
    // becomes a flat index walk. Inputs are line-sized (small).
    let cps: Vec<(usize, char)> = s.char_indices().collect();
    let mut out = Vec::new();
    let n = cps.len();
    let mut i = 0usize;
    while i < n {
        let (start, base) = cps[i];
        let mut j = i + 1; // next cp index
        let mut width = char_width(base);

        // Regional indicator: pair two consecutive RIs into one cluster.
        if is_regional_indicator(base as u32) {
            if j < n && is_regional_indicator(cps[j].1 as u32) {
                j += 1;
            }
            width = 2;
        } else {
            // Extender loop: combining marks, VS, skin tones, ZWJ-chains.
            loop {
                if j >= n {
                    break;
                }
                let cp = cps[j].1 as u32;
                if cp == ZWJ {
                    // Consume ZWJ and (if present) the joined codepoint.
                    j += 1;
                    if j < n {
                        j += 1; // the joined codepoint
                        width = 2; // ZWJ sequences render as one emoji cell-pair
                    }
                    continue;
                }
                if cp == VS16 {
                    j += 1;
                    width = 2;
                    continue;
                }
                if cp == VS15 {
                    j += 1;
                    width = 1;
                    continue;
                }
                if is_skin_tone(cp) {
                    j += 1;
                    width = 2;
                    continue;
                }
                if is_variation_selector(cp) || in_table(ZERO_WIDTH, cp) {
                    j += 1;
                    continue;
                }
                break;
            }
        }
        let end = if j < n { cps[j].0 } else { s.len() };
        out.push(Grapheme { start, end, width });
        i = j;
    }
    out
}

/// Display width of a valid UTF-8 string, computed over grapheme clusters.
pub fn string_width(s: &str) -> u32 {
    grapheme_spans(s).iter().map(|g| g.width).sum()
}

/// Display width of arbitrary bytes: valid UTF-8 chunks cluster normally,
/// each invalid byte counts as width 1 (never panics).
pub fn string_width_bytes(bytes: &[u8]) -> u32 {
    let mut w = 0u32;
    for chunk in bytes.utf8_chunks() {
        w += string_width(chunk.valid());
        w += chunk.invalid().len() as u32;
    }
    w
}

/// Truncate a valid UTF-8 string to at most `max_width` display cells at
/// grapheme-cluster boundaries. When truncation occurs and `ellipsis` is set,
/// a single `…` (width 1) is appended within the budget (a trailing width-2
/// cluster may be dropped to make room). Returns the truncated bytes; if the
/// whole string already fits, the input is returned unchanged.
pub fn truncate_to_width(s: &str, max_width: u32, ellipsis: bool) -> String {
    let spans = grapheme_spans(s);
    let mut kept_end = 0usize;
    let mut width = 0u32;
    for g in &spans {
        if width + g.width > max_width {
            break;
        }
        width += g.width;
        kept_end = g.end;
    }
    if kept_end == s.len() {
        return s.to_string();
    }
    // Truncation occurred.
    if !ellipsis || max_width == 0 {
        return s[..kept_end].to_string();
    }
    // Reserve 1 cell for the ellipsis, dropping trailing kept clusters if
    // needed so the marker fits inside max_width.
    let mut end = kept_end;
    let mut w = width;
    while w + 1 > max_width {
        // remove the last kept cluster
        let prev = spans
            .iter()
            .rev()
            .find(|g| g.end <= end && g.start < end)
            .copied();
        match prev {
            Some(g) => {
                w = w.saturating_sub(g.width);
                end = g.start;
            }
            None => {
                end = 0;
                break;
            }
        }
    }
    let mut out = String::with_capacity(end + 3);
    out.push_str(&s[..end]);
    out.push('\u{2026}');
    out
}

/// Slice the substring covering display columns `[from, from+len)` (clamped).
/// Clusters partially outside the window are included on entry / dropped on
/// exit; returns the byte slice of the covered region.
pub fn slice_by_width(s: &str, from: u32, len: u32) -> &str {
    let spans = grapheme_spans(s);
    let mut col = 0u32;
    let mut start_byte = None;
    let mut end_byte = s.len();
    let limit = from.saturating_add(len);
    for g in &spans {
        let g_end_col = col + g.width;
        if start_byte.is_none() && g_end_col > from {
            start_byte = Some(g.start);
        }
        if start_byte.is_some() && g_end_col > limit {
            end_byte = g.start;
            break;
        }
        col = g_end_col;
        if start_byte.is_some() {
            end_byte = g.end;
        }
    }
    let start = start_byte.unwrap_or(s.len());
    let start = start.min(end_byte);
    &s[start..end_byte]
}

// ---------------------------------------------------------------------------
// FFI implementations (called from abi.rs).
// ---------------------------------------------------------------------------

pub(crate) fn width_impl(ptr: *const u8, len: u32) -> i64 {
    if ptr.is_null() {
        return if len == 0 { 0 } else { -1 };
    }
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len as usize) };
    string_width_bytes(bytes) as i64
}

/// Build the truncated output into `out` (min(total, cap)); return total
/// bytes needed. Null `out` with cap>0 → -1.
pub(crate) fn truncate_impl(
    ptr: *const u8,
    len: u32,
    max_width: u32,
    ellipsis: u8,
    out: *mut u8,
    cap: u32,
) -> i64 {
    if ptr.is_null() {
        return -1;
    }
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len as usize) };
    // Truncate each valid UTF-8 chunk; preserve invalid bytes verbatim.
    let mut built: Vec<u8> = Vec::new();
    for chunk in bytes.utf8_chunks() {
        let t = truncate_to_width(chunk.valid(), max_width, ellipsis != 0);
        built.extend_from_slice(t.as_bytes());
        built.extend_from_slice(chunk.invalid());
    }
    let total = built.len();
    if total == 0 {
        return 0;
    }
    if out.is_null() {
        return if cap == 0 { 0 } else { -1 };
    }
    let n = (total as u32).min(cap) as usize;
    unsafe {
        std::ptr::copy_nonoverlapping(built.as_ptr(), out, n);
    }
    total as i64
}

// keep the abi import referenced even if constants move around
const _: u32 = abi::COLOR_TAG_DEFAULT;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_width() {
        assert_eq!(string_width("hello"), 5);
        assert_eq!(string_width(""), 0);
    }

    #[test]
    fn cjk_is_two() {
        assert_eq!(string_width("中文"), 4); // two Han chars
        assert_eq!(string_width("a中"), 3); // 1 + 2
        assert_eq!(char_width('中'), 2);
        assert_eq!(char_width('こ'), 2); // Hiragana
        assert_eq!(char_width('カ'), 2); // Katakana
        assert_eq!(char_width('한'), 2); // Hangul syllable
        assert_eq!(char_width('ｈ'), 2); // fullwidth latin (FF48)
    }

    #[test]
    fn combining_is_zero() {
        // e + combining acute
        assert_eq!(string_width("e\u{0301}"), 1);
        assert_eq!(char_width('\u{0301}'), 0);
    }

    #[test]
    fn control_is_zero() {
        assert_eq!(char_width('\u{0}'), 0);
        assert_eq!(char_width('\n'), 0);
        assert_eq!(char_width('\r'), 0);
        assert_eq!(char_width('\t'), 0);
        assert_eq!(char_width('\u{7F}'), 0); // DEL
        assert_eq!(char_width('\u{9F}'), 0); // C1
    }

    #[test]
    fn emoji_are_two() {
        assert_eq!(char_width('\u{1F600}'), 2); // 😀
        assert_eq!(string_width("😀"), 2);
    }

    #[test]
    fn zwj_family_is_one_cluster() {
        // 👨‍👩‍👧 : man + ZWJ + woman + ZWJ + girl → one cluster, width 2
        let s = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
        let spans = grapheme_spans(s);
        assert_eq!(spans.len(), 1, "{:?}", spans);
        assert_eq!(spans[0].width, 2);
        assert_eq!(string_width(s), 2);
    }

    #[test]
    fn zwj_skin_tone_cluster() {
        // 👍🏽 thumbs up + skin tone
        let s = "\u{1F44D}\u{1F3FD}";
        let spans = grapheme_spans(s);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].width, 2);
        assert_eq!(string_width(s), 2);
    }

    #[test]
    fn regional_indicator_pair_is_one_cluster() {
        // 🇺🇸 : two RI → one flag cluster, width 2 (not 4)
        let s = "\u{1F1FA}\u{1F1F8}";
        let spans = grapheme_spans(s);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].width, 2);
        assert_eq!(string_width(s), 2);
    }

    #[test]
    fn two_flags_are_two_clusters() {
        // 🇺🇸🇯🇵 : four RI → two flag clusters
        let s = "\u{1F1FA}\u{1F1F8}\u{1F1EF}\u{1F1F5}";
        let spans = grapheme_spans(s);
        assert_eq!(spans.len(), 2);
        assert_eq!(string_width(s), 4);
    }

    #[test]
    fn vs16_forces_wide() {
        // ❤ (U+2764) already wide in our table, but VS16 keeps width 2 and
        // forms a single cluster with the selector.
        let s = "\u{2764}\u{FE0F}";
        let spans = grapheme_spans(s);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].width, 2);
    }

    #[test]
    fn vs15_forces_narrow() {
        // ❤ + VS15 → text presentation, width 1.
        let s = "\u{2764}\u{FE0E}";
        let spans = grapheme_spans(s);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].width, 1);
    }

    #[test]
    fn truncate_keeps_clusters() {
        assert_eq!(truncate_to_width("hello world", 5, false), "hello");
        // CJK: 中 (2) + 文 (2) → "中" only at width 3 (drops 文 whole)
        assert_eq!(truncate_to_width("中文", 3, false), "中");
    }

    #[test]
    fn truncate_fits_unchanged() {
        assert_eq!(truncate_to_width("abc", 10, false), "abc");
        assert_eq!(truncate_to_width("abc", 3, true), "abc"); // exact fit, no ellipsis
    }

    #[test]
    fn truncate_ellipsis() {
        // "hello world" truncate to 8 with ellipsis → "hello w…" (7+1=8)
        assert_eq!(truncate_to_width("hello world", 8, true), "hello w…");
        // narrow room after a wide cluster: "中文x" to width 3 ellipsis → "中…"
        assert_eq!(truncate_to_width("中文x", 3, true), "中…");
    }

    #[test]
    fn truncate_ellipsis_drops_wide_for_room() {
        // "中abcdef" → width 4 with ellipsis: keep 中(2)+a(1)=3, +… =4 → "中a…"
        assert_eq!(truncate_to_width("中abcdef", 4, true), "中a…");
    }

    #[test]
    fn truncate_zero() {
        assert_eq!(truncate_to_width("abc", 0, false), "");
        assert_eq!(truncate_to_width("abc", 0, true), ""); // no room even for ellipsis
    }

    #[test]
    fn slice_by_width_basic() {
        assert_eq!(slice_by_width("abcdef", 2, 3), "cde");
        // CJK: "中文x" columns: 中[0,2) 文[2,4) x[4,5). slice(2,2) → "文"
        assert_eq!(slice_by_width("中文x", 2, 2), "文");
    }

    #[test]
    fn invalid_utf8_width_is_per_byte() {
        // 0xFF is invalid on its own → width 1
        let bad: &[u8] = &[0xFF, 0xFE];
        assert_eq!(string_width_bytes(bad), 2);
        // valid 'a' + invalid 0xFF → 1 + 1
        assert_eq!(string_width_bytes(b"a\xFF"), 2);
    }

    #[test]
    fn table_search_is_correct() {
        assert!(in_table(WIDE, 0x4E00));
        assert!(!in_table(WIDE, 0x41));
        assert!(in_table(ZERO_WIDTH, 0x0301));
        assert!(in_table(WIDE_ASTRAL, 0x1F600));
    }
}
