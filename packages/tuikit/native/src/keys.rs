//! Incremental keyboard parser (hand-written, zero crates).
//!
//! A byte-stream state machine that survives arbitrary input chunking: split
//! UTF-8 sequences, split CSI/SS3 escape sequences, and bracketed-paste bodies
//! spanning many reads all decode correctly. State lives in [`KeyParser`] and
//! persists across [`feed`](KeyParser::feed) calls.
//!
//! ## States
//! [`St::Ground`] → [`St::Esc`] (on `ESC`) → [`St::Csi`] (`ESC [`) / [`St::Ss3`]
//! (`ESC O`); multibyte text assembles in [`St::Utf8`]; bracketed paste streams
//! into [`St::Paste`] until the `ESC[201~` terminator.
//!
//! ## Modifier encoding
//! The contract stores decoded modifier bits: shift=1, alt=2, ctrl=4, super=8
//! (see `MOD_*`). Legacy xterm `CSI 1;<pm> X` sends `pm` whose `pm-1` maps
//! 1:1 onto those bits (shift/alt/ctrl/super). Kitty `CSI …;<km> u` sends
//! `1 + kitty-mask` where kitty's super lives in bit 4 (value 16) — we remap
//! that to the contract's bit 3 (value 8); numlock (kitty bit 3) is dropped.

use crate::abi::{
    KeyEventRec, KEY_CODE_BACKSPACE, KEY_CODE_DELETE, KEY_CODE_DOWN, KEY_CODE_END,
    KEY_CODE_ENTER, KEY_CODE_F1, KEY_CODE_F2, KEY_CODE_F3, KEY_CODE_F4, KEY_CODE_F5,
    KEY_CODE_F6, KEY_CODE_F7, KEY_CODE_F8, KEY_CODE_F9, KEY_CODE_F10, KEY_CODE_F11,
    KEY_CODE_F12, KEY_CODE_HOME, KEY_CODE_INSERT, KEY_CODE_LEFT, KEY_CODE_PAGE_DOWN,
    KEY_CODE_PAGE_UP, KEY_CODE_RIGHT, KEY_CODE_TAB, KEY_CODE_UP, KEY_EVENT_LEGACY,
    KEY_EVENT_PRESS, KEY_KIND_ESC, KEY_KIND_KEY, KEY_KIND_PASTE, MOD_ALT, MOD_CTRL, MOD_SHIFT, MOD_SUPER,
};

// ---------------------------------------------------------------------------
// Internal event (decoded), assembled into the FFI out buffer at the end.
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Event {
    pub kind: u8,         // KEY_KIND_*
    pub event_type: u8,   // KEY_EVENT_* (0 = legacy/press)
    pub key_code: u16,    // KEY_CODE_*; 0 = text in payload
    pub mods: u8,         // MOD_* bits
    pub payload: Vec<u8>, // text / paste body
}

impl Event {
    fn key(code: u16, mods: u8) -> Self {
        Event { kind: KEY_KIND_KEY, event_type: KEY_EVENT_LEGACY, key_code: code, mods, payload: Vec::new() }
    }
    fn text(bytes: Vec<u8>, mods: u8) -> Self {
        Event { kind: KEY_KIND_KEY, event_type: KEY_EVENT_LEGACY, key_code: 0, mods, payload: bytes }
    }
    fn esc() -> Self {
        Event { kind: KEY_KIND_ESC, event_type: KEY_EVENT_LEGACY, key_code: 0, mods: 0, payload: Vec::new() }
    }
    fn paste(body: Vec<u8>) -> Self {
        Event { kind: KEY_KIND_PASTE, event_type: KEY_EVENT_LEGACY, key_code: 0, mods: 0, payload: body }
    }
}

// ---------------------------------------------------------------------------
// Parser state
// ---------------------------------------------------------------------------

#[derive(Clone)]
enum St {
    Ground,
    Esc,
    /// Collecting CSI bytes between `ESC [` and the final byte (0x40..=0x7E).
    Csi(Vec<u8>),
    /// `ESC O` — awaiting the single SS3 final byte.
    Ss3,
    /// Inside a bracketed paste; `term` counts matched terminator bytes.
    Paste { body: Vec<u8>, term: u8 },
    /// Assembling one multibyte UTF-8 text codepoint (possibly with mods).
    Utf8 { buf: [u8; 4], need: u8, have: u8, mods: u8 },
    /// Swallowing an OSC sequence (`ESC ] ... BEL|ESC\`) — terminal REPORTS,
    /// not user input. The kernel delivers a terminal's answer to an OSC
    /// query (background colour, clipboard, …) on the same stdin bytes as
    /// keystrokes. Before this state existed the parser fell back to
    /// Alt+char, leaking replies like `11;rgb:2828/2828/2828` into the
    /// editor as if the user had typed them.
    Osc { esc: bool },
}

/// Incremental keyboard parser. Re-exported as `abi::KeyParser`.
pub struct KeyParser {
    state: St,
    /// True when a bare `ESC` ended the previous feed unresolved; the next
    /// feed's first byte decides ESC-as-escape vs bare-ESC-event.
    esc_pending: bool,
}

impl Clone for KeyParser {
    fn clone(&self) -> Self {
        KeyParser { state: self.state.clone(), esc_pending: self.esc_pending }
    }
}

impl Default for KeyParser {
    fn default() -> Self {
        KeyParser { state: St::Ground, esc_pending: false }
    }
}

/// The `ESC[201~` paste terminator.
const PASTE_TERM: [u8; 6] = [0x1b, b'[', b'2', b'0', b'1', b'~'];

impl KeyParser {
    pub fn new() -> Self {
        KeyParser::default()
    }

    /// Feed a chunk of bytes; returns the events completed by this chunk.
    pub(crate) fn feed(&mut self, bytes: &[u8]) -> Vec<Event> {
        let mut events = Vec::new();

        // Prelude: resolve a pending bare ESC from the previous feed.
        if self.esc_pending && !bytes.is_empty() {
            let b0 = bytes[0];
            if b0 == b'[' || b0 == b'O' || b0 == b']' {
                // Continues an escape sequence (CSI / SS3 / OSC) — clear
                // pending and let the main loop process b0 in the Esc state.
                self.esc_pending = false;
            } else {
                // Not an escape continuation → bare ESC, then b0 in Ground.
                events.push(Event::esc());
                self.state = St::Ground;
                self.esc_pending = false;
            }
        }

        let mut i = 0usize;
        while i < bytes.len() {
            let b = bytes[i];
            if self.step(b, &mut events) {
                i += 1;
            }
            // else: reprocess the same byte (state has already changed).
        }

        // Post: an unresolved ESC at chunk end is held pending.
        if matches!(self.state, St::Esc) {
            self.esc_pending = true;
        }

        events
    }

    /// Process one byte. Returns `true` if the byte was consumed, `false` to
    /// reprocess it (the state has already been changed in that case).
    fn step(&mut self, b: u8, events: &mut Vec<Event>) -> bool {
        // Take ownership of the state to avoid borrow conflicts; replace after.
        let st = std::mem::replace(&mut self.state, St::Ground);
        match st {
            St::Ground => self.step_ground(b, events),
            St::Esc => {
                let r = self.step_esc(b, events);
                if matches!(self.state, St::Esc) {
                    // step_esc did not transition — but it always does. Defensive:
                }
                r
            }
            St::Csi(mut buf) => self.step_csi(b, &mut buf, events),
            St::Ss3 => {
                self.dispatch_ss3(b, events);
                self.state = St::Ground;
                true
            }
            St::Paste { mut body, mut term } => self.step_paste(b, &mut body, &mut term, events),
            St::Utf8 { mut buf, need, have, mods } => {
                self.step_utf8(b, &mut buf, need, have, mods, events)
            }
            St::Osc { esc } => {
                // Swallow until BEL or the \ of a closing ESC \ (ST).
                match (esc, b) {
                    (true, b'\\') => self.state = St::Ground, // ST complete
                    (true, _) => self.state = St::Osc { esc: false },
                    (false, 0x07) => self.state = St::Ground, // BEL complete
                    (false, 0x1b) => self.state = St::Osc { esc: true },
                    (false, _) => self.state = St::Osc { esc: false },
                }
                true
            }
        }
    }

    fn step_ground(&mut self, b: u8, events: &mut Vec<Event>) -> bool {
        match b {
            0x00 => {
                // NUL — pass through as a text event (round-trips verbatim).
                events.push(Event::text(vec![0], 0));
                self.state = St::Ground;
                true
            }
            0x1b => {
                self.state = St::Esc;
                true
            }
            0x0d | 0x0a => {
                events.push(Event::key(KEY_CODE_ENTER, 0));
                self.state = St::Ground;
                true
            }
            0x09 => {
                events.push(Event::key(KEY_CODE_TAB, 0));
                self.state = St::Ground;
                true
            }
            0x08 | 0x7f => {
                events.push(Event::key(KEY_CODE_BACKSPACE, 0));
                self.state = St::Ground;
                true
            }
            0x01..=0x1a => {
                // Ctrl+a .. Ctrl+z
                let ch = b'a' + (b - 1);
                events.push(Event::text(vec![ch], MOD_CTRL));
                self.state = St::Ground;
                true
            }
            0x1c => {
                events.push(Event::text(vec![b'\\'], MOD_CTRL));
                self.state = St::Ground;
                true
            }
            0x1d => {
                events.push(Event::text(vec![b']'], MOD_CTRL));
                self.state = St::Ground;
                true
            }
            0x1e => {
                events.push(Event::text(vec![b'^'], MOD_CTRL));
                self.state = St::Ground;
                true
            }
            0x1f => {
                events.push(Event::text(vec![b'_'], MOD_CTRL));
                self.state = St::Ground;
                true
            }
            0x20..=0x7e => {
                events.push(Event::text(vec![b], 0));
                self.state = St::Ground;
                true
            }
            0x80..=0xbf => {
                // Stray UTF-8 continuation byte with no preceding lead — this
                // can never be part of a well-formed input stream, so DROP it
                // silently (do not surface as a text event: the TS layer
                // decodes payloads with TextDecoder, which would turn a lone
                // continuation byte into U+FFFD and inject a garbage '�' key
                // event). See the tuikit_keys_feed contract in abi.rs.
                self.state = St::Ground;
                true
            }
            0xc0 | 0xc1 | 0xf5..=0xff => {
                // Invalid UTF-8 lead (overlong / out of range) — same rationale
                // as stray continuation bytes: drop silently rather than emit a
                // malformed text event that decodes to U+FFFD.
                self.state = St::Ground;
                true
            }
            0xc2..=0xdf | 0xe0..=0xef | 0xf0..=0xf4 => {
                let need = utf8_lead_len(b);
                self.state = St::Utf8 { buf: [b, 0, 0, 0], need, have: 1, mods: 0 };
                true
            }
        }
    }

    fn step_esc(&mut self, b: u8, events: &mut Vec<Event>) -> bool {
        match b {
            b'[' => {
                self.state = St::Csi(Vec::new());
                true
            }
            b'O' => {
                self.state = St::Ss3;
                true
            }
            b']' => {
                // OSC — a terminal report (or title set), never user input:
                // swallow through BEL / ST.
                self.state = St::Osc { esc: false };
                true
            }
            // Intermediates / DCS / OSC starters we don't model: drop to Ground
            // (consume) to avoid swallowing following bytes as Alt+char.
            0x20..=0x2f | b'P' | b'X' | b'^' | b'_' | b'\\' => {
                self.state = St::Ground;
                true
            }
            0x30..=0x7e => {
                // Alt + ASCII printable
                events.push(Event::text(vec![b], MOD_ALT));
                self.state = St::Ground;
                true
            }
            c if c >= 0x80 => {
                // Alt + multibyte char — start UTF-8 with MOD_ALT.
                if (0xc2..=0xf4).contains(&c) {
                    let need = utf8_lead_len(c);
                    self.state = St::Utf8 { buf: [c, 0, 0, 0], need, have: 1, mods: MOD_ALT };
                } else {
                    events.push(Event::text(vec![c], MOD_ALT));
                    self.state = St::Ground;
                }
                true
            }
            _ => {
                // Control after ESC: emit a bare ESC, then reprocess b in Ground.
                events.push(Event::esc());
                self.state = St::Ground;
                false
            }
        }
    }

    fn step_csi(&mut self, b: u8, buf: &mut Vec<u8>, events: &mut Vec<Event>) -> bool {
        if (0x40..=0x7e).contains(&b) {
            let body = std::mem::take(buf);
            self.dispatch_csi(&body, b, events);
        } else {
            buf.push(b);
            self.state = St::Csi(std::mem::take(buf));
        }
        true
    }

    fn dispatch_ss3(&mut self, b: u8, events: &mut Vec<Event>) {
        let code = match b {
            b'A' => Some(KEY_CODE_UP),
            b'B' => Some(KEY_CODE_DOWN),
            b'C' => Some(KEY_CODE_RIGHT),
            b'D' => Some(KEY_CODE_LEFT),
            b'H' => Some(KEY_CODE_HOME),
            b'F' => Some(KEY_CODE_END),
            b'P' => Some(KEY_CODE_F1),
            b'Q' => Some(KEY_CODE_F2),
            b'R' => Some(KEY_CODE_F3),
            b'S' => Some(KEY_CODE_F4),
            _ => None,
        };
        if let Some(c) = code {
            events.push(Event::key(c, 0));
        }
    }

    fn dispatch_csi(&mut self, body: &[u8], finalb: u8, events: &mut Vec<Event>) {
        // Default next state is Ground; the paste starter overrides it.
        self.state = St::Ground;
        let (priv_marker, params) = parse_params(body);
        let _ = priv_marker;
        match finalb {
            b'A' => events.push(Event::key(KEY_CODE_UP, mods_csi(&params))),
            b'B' => events.push(Event::key(KEY_CODE_DOWN, mods_csi(&params))),
            b'C' => events.push(Event::key(KEY_CODE_RIGHT, mods_csi(&params))),
            b'D' => events.push(Event::key(KEY_CODE_LEFT, mods_csi(&params))),
            b'H' => events.push(Event::key(KEY_CODE_HOME, mods_csi(&params))),
            b'F' => events.push(Event::key(KEY_CODE_END, mods_csi(&params))),
            b'Z' => events.push(Event::key(KEY_CODE_TAB, MOD_SHIFT)),
            b'~' => self.dispatch_tilde(&params, events),
            b'u' => self.dispatch_kitty(body, &params, events),
            // Mouse (M/m) and unknown finals: consume silently.
            _ => {}
        }
    }

    fn dispatch_tilde(&mut self, params: &[u32], events: &mut Vec<Event>) {
        let keynum = params.first().copied().unwrap_or(0);
        let mods = if params.len() >= 2 { legacy_decode(params[1]) } else { 0 };
        // Bracketed-paste start: enter Paste state, emit nothing.
        if keynum == 200 {
            self.state = St::Paste { body: Vec::new(), term: 0 };
            return;
        }
        if keynum == 201 {
            // Stray end marker outside paste — ignore.
            return;
        }
        let code = match keynum {
            1 => Some(KEY_CODE_HOME),
            2 => Some(KEY_CODE_INSERT),
            3 => Some(KEY_CODE_DELETE),
            4 => Some(KEY_CODE_END),
            5 => Some(KEY_CODE_PAGE_UP),
            6 => Some(KEY_CODE_PAGE_DOWN),
            11 => Some(KEY_CODE_F1),
            12 => Some(KEY_CODE_F2),
            13 => Some(KEY_CODE_F3),
            14 => Some(KEY_CODE_F4),
            15 => Some(KEY_CODE_F5),
            17 => Some(KEY_CODE_F6),
            18 => Some(KEY_CODE_F7),
            19 => Some(KEY_CODE_F8),
            20 => Some(KEY_CODE_F9),
            21 => Some(KEY_CODE_F10),
            23 => Some(KEY_CODE_F11),
            24 => Some(KEY_CODE_F12),
            _ => None,
        };
        if let Some(c) = code {
            events.push(Event::key(c, mods));
        }
    }

    fn dispatch_kitty(&mut self, body: &[u8], _params: &[u32], events: &mut Vec<Event>) {
        // Split the body (between '[' and 'u') by ';'.
        let segs: Vec<&[u8]> = body.split(|&c| c == b';').collect();
        if segs.is_empty() {
            return;
        }
        // seg[0] may contain ':' (key:shifted:base); take the first subfield.
        let key_cp = segs[0].split(|&c| c == b':').next().and_then(parse_u32_opt).unwrap_or(0);
        let mods = segs.get(1).and_then(|s| parse_u32_opt(s)).map(kitty_decode).unwrap_or(0);
        let event_type = segs.get(2).and_then(|s| parse_u32_opt(s)).unwrap_or(KEY_EVENT_PRESS as u32) as u8;

        // Optional text codepoints in the last segment (colon-separated), only
        // when present (>= 4 segments).
        let mut text = Vec::new();
        if segs.len() >= 4 {
            for cp_str in segs[3].split(|&c| c == b':') {
                if let Some(cp) = parse_u32_opt(cp_str) {
                    if let Some(c) = char::from_u32(cp) {
                        let mut b = [0u8; 4];
                        let s = c.encode_utf8(&mut b);
                        text.extend_from_slice(s.as_bytes());
                    }
                }
            }
        }

        // Named control codepoints.
        let named = match key_cp {
            13 | 10 => Some(KEY_CODE_ENTER),
            9 => Some(KEY_CODE_TAB),
            127 | 8 => Some(KEY_CODE_BACKSPACE),
            27 => {
                events.push(Event { kind: KEY_KIND_ESC, event_type, key_code: 0, mods, payload: Vec::new() });
                return;
            }
            _ => None,
        };
        if let Some(code) = named {
            events.push(Event { kind: KEY_KIND_KEY, event_type, key_code: code, mods, payload: Vec::new() });
            return;
        }
        // Printable: prefer explicit text, else encode the key codepoint.
        if !text.is_empty() {
            events.push(Event { kind: KEY_KIND_KEY, event_type, key_code: 0, mods, payload: text });
        } else if let Some(c) = char::from_u32(key_cp) {
            let mut b = [0u8; 4];
            let s = c.encode_utf8(&mut b);
            events.push(Event { kind: KEY_KIND_KEY, event_type, key_code: 0, mods, payload: s.as_bytes().to_vec() });
        }
        // Unknown kitty function-key codepoint → drop.
    }

    fn step_paste(
        &mut self,
        b: u8,
        body: &mut Vec<u8>,
        term: &mut u8,
        events: &mut Vec<Event>,
    ) -> bool {
        let exp = PASTE_TERM[*term as usize];
        if b == exp {
            *term += 1;
            if *term as usize == PASTE_TERM.len() {
                let payload = std::mem::take(body);
                events.push(Event::paste(payload));
                self.state = St::Ground;
            } else {
                self.state = St::Paste { body: std::mem::take(body), term: *term };
            }
            // Terminator bytes are not part of the paste body.
            return true;
        }
        // Mismatch: the tentatively-skipped prefix is actually body content.
        body.extend_from_slice(&PASTE_TERM[..*term as usize]);
        *term = 0;
        if b == PASTE_TERM[0] {
            *term = 1;
        } else {
            body.push(b);
        }
        self.state = St::Paste { body: std::mem::take(body), term: *term };
        true
    }

    fn step_utf8(
        &mut self,
        b: u8,
        buf: &mut [u8; 4],
        need: u8,
        have: u8,
        mods: u8,
        events: &mut Vec<Event>,
    ) -> bool {
        if (0x80..=0xbf).contains(&b) {
            buf[have as usize] = b;
            let have2 = have + 1;
            if have2 == need {
                let payload = buf[..need as usize].to_vec();
                events.push(Event::text(payload, mods));
                self.state = St::Ground;
            } else {
                self.state = St::Utf8 { buf: *buf, need, have: have2, mods };
            }
            true
        } else {
            // Invalid continuation: flush what we have, reset to Ground,
            // reprocess the offending byte.
            let payload = buf[..have as usize].to_vec();
            events.push(Event::text(payload, mods));
            self.state = St::Ground;
            false
        }
    }
}

// ---------------------------------------------------------------------------
// Param parsing & modifier decode
// ---------------------------------------------------------------------------

/// UTF-8 sequence length implied by a lead byte (caller guarantees a valid lead).
fn utf8_lead_len(lead: u8) -> u8 {
    if lead >= 0xf0 {
        4
    } else if lead >= 0xe0 {
        3
    } else {
        2
    }
}

/// Parse CSI params: returns (had_private_marker, values). Empty fields → 0.
fn parse_params(body: &[u8]) -> (bool, Vec<u32>) {
    let mut start = 0;
    if let Some(&first) = body.first() {
        if matches!(first, b'?' | b'>' | b'<' | b'=' | b'!') {
            start = 1;
        }
    }
    let rest = &body[start..];
    let mut out = Vec::new();
    for field in rest.split(|&c| c == b';') {
        out.push(parse_u32_opt(field).unwrap_or(0));
    }
    (start == 1, out)
}

fn parse_u32_opt(bytes: &[u8]) -> Option<u32> {
    if bytes.is_empty() {
        return None;
    }
    let mut v = 0u32;
    for &c in bytes {
        if !(b'0'..=b'9').contains(&c) {
            return None;
        }
        v = v.checked_mul(10)?.checked_add((c - b'0') as u32)?;
    }
    Some(v)
}

/// Legacy xterm modifier decode: `pm-1` maps 1:1 onto shift(1)/alt(2)/ctrl(4)/super(8).
fn legacy_decode(pm: u32) -> u8 {
    if pm == 0 {
        return 0;
    }
    let m = pm - 1;
    (m & (MOD_SHIFT as u32 | MOD_ALT as u32 | MOD_CTRL as u32 | MOD_SUPER as u32)) as u8
}

/// Kitty modifier decode: transmitted = 1 + kitty_mask; kitty super is bit 4
/// (value 16), remapped to contract bit 3 (value 8); numlock (bit 3) dropped.
fn kitty_decode(transmitted: u32) -> u8 {
    if transmitted == 0 {
        return 0;
    }
    let m = transmitted - 1;
    let mut mods = (m & (MOD_SHIFT as u32 | MOD_ALT as u32 | MOD_CTRL as u32)) as u8;
    if m & 16 != 0 {
        mods |= MOD_SUPER;
    }
    mods
}

/// Extract the modifier word from a CSI param list (`[1, <pm>]` form).
fn mods_csi(params: &[u32]) -> u8 {
    if params.len() >= 2 {
        legacy_decode(params[1])
    } else {
        0
    }
}

// ---------------------------------------------------------------------------
// Output assembly — lay events out into the FFI out buffer.
// ---------------------------------------------------------------------------

/// Build the full out buffer: `[u32 count][N * KeyEventRec][payload arena]`.
pub(crate) fn assemble(events: &[Event]) -> Vec<u8> {
    let n = events.len();
    let header = 4usize;
    let recs = n * std::mem::size_of::<KeyEventRec>();
    let mut out = Vec::with_capacity(header + recs);
    out.extend_from_slice(&(n as u32).to_le_bytes());
    // First pass: record each payload's arena offset, building the arena.
    let arena_base = (header + recs) as u32;
    let mut arena = Vec::new();
    let mut offsets = Vec::with_capacity(n);
    for ev in events {
        let ofs = arena_base + arena.len() as u32;
        offsets.push(ofs);
        arena.extend_from_slice(&ev.payload);
    }
    // Second pass: write records.
    for (ev, &ofs) in events.iter().zip(offsets.iter()) {
        let rec = KeyEventRec {
            kind: ev.kind,
            event_type: ev.event_type,
            key_code: ev.key_code,
            mods: ev.mods,
            _pad: 0,
            text_len: ev.payload.len().min(u16::MAX as usize) as u16,
            text_ofs: ofs,
            _reserved: 0,
        };
        let bytes = unsafe {
            std::slice::from_raw_parts(
                &rec as *const KeyEventRec as *const u8,
                std::mem::size_of::<KeyEventRec>(),
            )
        };
        out.extend_from_slice(bytes);
    }
    out.extend_from_slice(&arena);
    out
}

// ---------------------------------------------------------------------------
// FFI implementations
// ---------------------------------------------------------------------------

pub(crate) fn keys_create_impl() -> *mut crate::abi::KeyParser {
    Box::into_raw(Box::new(KeyParser::new()))
}

pub(crate) fn keys_free_impl(handle: *mut crate::abi::KeyParser) {
    if handle.is_null() {
        return;
    }
    unsafe { drop(Box::from_raw(handle)) };
}

pub(crate) fn keys_feed_impl(
    handle: *mut crate::abi::KeyParser,
    bytes_ptr: *const u8,
    len: u32,
    out: *mut u8,
    cap: u32,
) -> i64 {
    if handle.is_null() {
        return -1;
    }
    let bytes: &[u8] = if bytes_ptr.is_null() || len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(bytes_ptr, len as usize) }
    };

    // Snapshot the committed parser, feed the snapshot, build the output.
    // We commit ONLY when the output fits — otherwise the input is treated as
    // unconsumed and TS re-feeds the same bytes after growing the buffer.
    let parser = unsafe { &mut *handle };
    let mut snap = parser.clone();
    let events = snap.feed(bytes);
    let built = assemble(&events);
    let total = built.len();

    if total == 0 {
        // Nothing to emit (but partial state may have advanced). 0 always fits,
        // so commit the state advance.
        *parser = snap;
        return 0;
    }

    if out.is_null() {
        // total > 0 here.
        return if cap == 0 { total as i64 } else { -1 };
    }

    if total <= cap as usize {
        // Fits — write everything and commit.
        unsafe {
            std::ptr::copy_nonoverlapping(built.as_ptr(), out, total);
        }
        *parser = snap;
        total as i64
    } else {
        // Overflow — write min(total, cap) (TS discards on overflow and retries),
        // do NOT commit (input not consumed).
        let n = (cap as usize).min(total);
        unsafe {
            std::ptr::copy_nonoverlapping(built.as_ptr(), out, n);
        }
        total as i64
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::abi::{
        tuikit_keys_create, tuikit_keys_feed, tuikit_keys_free, KEY_EVENT_PRESS,
        KEY_EVENT_RELEASE, KEY_KIND_ESC, KEY_KIND_KEY, KEY_KIND_PASTE, KEY_CODE_ENTER, MOD_ALT,
        MOD_CTRL, MOD_SHIFT,
    };

    /// Feed bytes through a fresh parser; return decoded events.
    fn run(bytes: &[u8]) -> Vec<Event> {
        let mut p = KeyParser::new();
        p.feed(bytes)
    }

    /// Feed bytes one at a time (worst-case chunking).
    fn run_split(bytes: &[u8]) -> Vec<Event> {
        let mut p = KeyParser::new();
        let mut all = Vec::new();
        for b in bytes {
            all.extend(p.feed(std::slice::from_ref(b)));
        }
        all
    }

    #[test]
    fn ascii_text() {
        let ev = run(b"a");
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0].kind, KEY_KIND_KEY);
        assert_eq!(ev[0].payload, b"a");
        assert_eq!(ev[0].mods, 0);
    }

    #[test]
    fn multibyte_split_byte_by_byte() {
        // é = 0xC3 0xA9
        let whole = run("é".as_bytes());
        let split = run_split("é".as_bytes());
        assert_eq!(whole, split);
        assert_eq!(whole[0].payload, "é".as_bytes());
    }

    #[test]
    fn cjk_split() {
        let whole = run("中".as_bytes());
        let split = run_split("中".as_bytes());
        assert_eq!(whole, split);
        assert_eq!(whole[0].payload, "中".as_bytes());
    }

    #[test]
    fn enter_tab_backspace() {
        let ev = run(b"\r");
        assert_eq!(ev[0].key_code, KEY_CODE_ENTER);
        let ev = run(b"\n");
        assert_eq!(ev[0].key_code, KEY_CODE_ENTER);
        let ev = run(b"\t");
        assert_eq!(ev[0].key_code, KEY_CODE_TAB);
        let ev = run(b"\x7f");
        assert_eq!(ev[0].key_code, KEY_CODE_BACKSPACE);
        let ev = run(b"\x08");
        assert_eq!(ev[0].key_code, KEY_CODE_BACKSPACE);
    }

    #[test]
    fn ctrl_letter() {
        let ev = run(b"\x01"); // Ctrl+A
        assert_eq!(ev[0].payload, b"a");
        assert_eq!(ev[0].mods, MOD_CTRL);
    }

    #[test]
    fn stray_continuation_byte_is_dropped() {
        // A lone 0x80 (UTF-8 continuation with no lead) is malformed and must
        // be DROPPED — not surfaced as a text event (which TextDecoder would
        // render as U+FFFD). Surrounding valid input still parses normally.
        let ev = run(b"a\x80b");
        assert_eq!(ev.len(), 2, "stray continuation must not yield an event");
        assert_eq!(ev[0].payload, b"a");
        assert_eq!(ev[1].payload, b"b");
    }

    #[test]
    fn stray_continuation_byte_range_dropped() {
        // Every byte in the continuation range 0x80..=0xbf is dropped on its own.
        for byte in [0x80u8, 0xbf, 0xa0, 0x90] {
            let ev = run(std::slice::from_ref(&byte));
            assert!(ev.is_empty(), "0x{:02x} should be dropped, got {:?}", byte, ev);
        }
    }

    #[test]
    fn invalid_utf8_leads_are_dropped() {
        // Overlong leads (0xc0, 0xc1) and out-of-range leads (0xf5..=0xff)
        // can never start a valid sequence — drop them silently.
        for byte in [0xc0u8, 0xc1, 0xf5, 0xfb, 0xff] {
            let ev = run(std::slice::from_ref(&byte));
            assert!(ev.is_empty(), "0x{:02x} should be dropped, got {:?}", byte, ev);
        }
        // And a run of garbage between valid bytes: only the valid bytes emit.
        let ev = run(&[b'x', 0xfe, 0xc0, b'y']);
        assert_eq!(ev.len(), 2);
        assert_eq!(ev[0].payload, b"x");
        assert_eq!(ev[1].payload, b"y");
    }

    #[test]
    fn nul_still_passes_through() {
        // NUL is the deliberate exception — it round-trips as a text event.
        let ev = run(b"\x00");
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0].payload, b"\x00");
    }

    #[test]
    fn arrows_and_modifiers() {
        let ev = run(b"\x1b[A");
        assert_eq!(ev[0].key_code, KEY_CODE_UP);
        let ev = run(b"\x1b[1;5A"); // Ctrl+Up
        assert_eq!(ev[0].key_code, KEY_CODE_UP);
        assert_eq!(ev[0].mods, MOD_CTRL);
        let ev = run(b"\x1b[1;2B"); // Shift+Down
        assert_eq!(ev[0].key_code, KEY_CODE_DOWN);
        assert_eq!(ev[0].mods, MOD_SHIFT);
        let ev = run(b"\x1b[1;3C"); // Alt+Right
        assert_eq!(ev[0].mods, MOD_ALT);
    }

    #[test]
    fn home_end_tilde_forms() {
        assert_eq!(run(b"\x1b[H")[0].key_code, KEY_CODE_HOME);
        assert_eq!(run(b"\x1b[F")[0].key_code, KEY_CODE_END);
        assert_eq!(run(b"\x1b[1~")[0].key_code, KEY_CODE_HOME);
        assert_eq!(run(b"\x1b[4~")[0].key_code, KEY_CODE_END);
        assert_eq!(run(b"\x1b[5~")[0].key_code, KEY_CODE_PAGE_UP);
        assert_eq!(run(b"\x1b[6~")[0].key_code, KEY_CODE_PAGE_DOWN);
        assert_eq!(run(b"\x1b[2~")[0].key_code, KEY_CODE_INSERT);
        assert_eq!(run(b"\x1b[3~")[0].key_code, KEY_CODE_DELETE);
    }

    #[test]
    fn function_keys() {
        // SS3 F1-F4
        assert_eq!(run(b"\x1bOP")[0].key_code, KEY_CODE_F1);
        assert_eq!(run(b"\x1bOQ")[0].key_code, KEY_CODE_F2);
        assert_eq!(run(b"\x1bOR")[0].key_code, KEY_CODE_F3);
        assert_eq!(run(b"\x1bOS")[0].key_code, KEY_CODE_F4);
        // Tilde F1..F12
        assert_eq!(run(b"\x1b[11~")[0].key_code, KEY_CODE_F1);
        assert_eq!(run(b"\x1b[15~")[0].key_code, KEY_CODE_F5);
        assert_eq!(run(b"\x1b[24~")[0].key_code, KEY_CODE_F12);
        // SS3 arrows
        assert_eq!(run(b"\x1bOA")[0].key_code, KEY_CODE_UP);
    }

    #[test]
    fn alt_plus_char_same_chunk() {
        let ev = run(b"\x1ba"); // ESC a
        assert_eq!(ev[0].payload, b"a");
        assert_eq!(ev[0].mods, MOD_ALT);
    }

    #[test]
    fn alt_plus_multibyte() {
        // ESC é
        let ev = run(&[0x1b, 0xc3, 0xa9]);
        assert_eq!(ev[0].payload, "é".as_bytes());
        assert_eq!(ev[0].mods, MOD_ALT);
    }

    #[test]
    fn bare_esc_at_chunk_end_then_printable() {
        // ESC alone, then 'a' in a separate feed.
        let mut p = KeyParser::new();
        let e1 = p.feed(b"\x1b");
        assert!(e1.is_empty()); // held pending
        let e2 = p.feed(b"a");
        assert_eq!(e2.len(), 2);
        assert_eq!(e2[0].kind, KEY_KIND_ESC);
        assert_eq!(e2[1].payload, b"a");
        assert_eq!(e2[1].mods, 0);
    }

    #[test]
    fn esc_then_continuation_next_feed() {
        // ESC at end, then "[A" next feed → Up (not bare ESC).
        let mut p = KeyParser::new();
        let _ = p.feed(b"\x1b");
        let e = p.feed(b"[A");
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].key_code, KEY_CODE_UP);
    }

    #[test]
    fn kitty_simple() {
        // CSI 97 u → 'a'
        let ev = run(b"\x1b[97u");
        assert_eq!(ev[0].payload, b"a");
        assert_eq!(ev[0].mods, 0);
        assert_eq!(ev[0].event_type, KEY_EVENT_PRESS);
    }

    #[test]
    fn kitty_with_mods() {
        // CSI 97;5 u → Ctrl+a
        let ev = run(b"\x1b[97;5u");
        assert_eq!(ev[0].payload, b"a");
        assert_eq!(ev[0].mods, MOD_CTRL);
    }

    #[test]
    fn kitty_release_event_type() {
        // CSI 97;2;3 u → Shift+a release
        let ev = run(b"\x1b[97;2;3u");
        assert_eq!(ev[0].mods, MOD_SHIFT);
        assert_eq!(ev[0].event_type, KEY_EVENT_RELEASE);
    }

    #[test]
    fn kitty_super_remaps_to_bit3() {
        // kitty super = bit4 value 16; transmitted = 1+16 = 17
        let ev = run(b"\x1b[97;17u");
        assert_eq!(ev[0].mods, MOD_SUPER);
    }

    #[test]
    fn kitty_named_enter() {
        // CSI 13 u → Enter
        let ev = run(b"\x1b[13u");
        assert_eq!(ev[0].key_code, KEY_CODE_ENTER);
    }

    #[test]
    fn bracketed_paste_round_trip() {
        let mut p = KeyParser::new();
        let start = b"\x1b[200~";
        let body = b"hello, paste\nworld";
        let end = b"\x1b[201~";
        let e1 = p.feed(start);
        assert!(e1.is_empty()); // entered paste
        let e2 = p.feed(body);
        assert!(e2.is_empty()); // accumulating
        let e3 = p.feed(end);
        assert_eq!(e3.len(), 1);
        assert_eq!(e3[0].kind, KEY_KIND_PASTE);
        assert_eq!(e3[0].payload, body);
    }

    #[test]
    fn bracketed_paste_split_every_byte() {
        let mut p = KeyParser::new();
        let seq: Vec<u8> = [b"\x1b[200~".as_ref(), b"abc".as_ref(), b"\x1b[201~".as_ref()].concat();
        let mut got = Vec::new();
        for b in &seq {
            got.extend(p.feed(std::slice::from_ref(b)));
        }
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].kind, KEY_KIND_PASTE);
        assert_eq!(got[0].payload, b"abc");
    }

    #[test]
    fn paste_body_containing_esc_sequences() {
        // Paste body contains an ANSI color code — it must remain in the body
        // and not be misread as the terminator.
        let mut p = KeyParser::new();
        let mut got: Vec<Event> = Vec::new();
        got.extend(p.feed(b"\x1b[200~"));
        got.extend(p.feed(b"\x1b[31mred\x1b[0m"));
        got.extend(p.feed(b"\x1b[201~"));
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].payload, b"\x1b[31mred\x1b[0m");
    }

    #[test]
    fn mixed_events_one_chunk() {
        // 'a' Up 'b'
        let ev = run(b"a\x1b[Ab");
        assert_eq!(ev.len(), 3);
        assert_eq!(ev[0].payload, b"a");
        assert_eq!(ev[1].key_code, KEY_CODE_UP);
        assert_eq!(ev[2].payload, b"b");
    }

    // -- FFI round-trip -------------------------------------------------------

    fn feed_ffi(p: *mut crate::abi::KeyParser, bytes: &[u8]) -> Vec<u8> {
        let mut cap = 256u32;
        let mut buf = vec![0u8; cap as usize];
        let mut total = tuikit_keys_feed(p, bytes.as_ptr(), bytes.len() as u32, buf.as_mut_ptr(), cap);
        while total as u32 > cap {
            cap = total as u32;
            buf = vec![0u8; cap as usize];
            total = tuikit_keys_feed(p, bytes.as_ptr(), bytes.len() as u32, buf.as_mut_ptr(), cap);
        }
        assert!(total >= 0);
        buf[..total as usize].to_vec()
    }

    #[test]
    fn ffi_text_round_trip() {
        let p = tuikit_keys_create();
        assert!(!p.is_null());
        let buf = feed_ffi(p, b"hi");
        // header count = 2
        let count = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]);
        assert_eq!(count, 2);
        // arena = "hi" at offset 4 + 2*16 = 36
        assert_eq!(&buf[36..38], b"hi");
        tuikit_keys_free(p);
    }

    #[test]
    fn ffi_overflow_not_consumed() {
        let p = tuikit_keys_create();
        // Tiny cap: total for 'a' = 4 + 16 + 1 = 21. Offer cap=8 → overflow.
        let mut small = [0u8; 8];
        let total = tuikit_keys_feed(p, b"a".as_ptr(), 1, small.as_mut_ptr(), 8);
        assert!(total > 8, "expected overflow, got {}", total);
        // Input not consumed — re-feed with adequate buffer must still yield 1 event.
        let buf = feed_ffi(p, b"a");
        let count = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]);
        assert_eq!(count, 1, "input must not have been consumed on overflow");
        tuikit_keys_free(p);
    }

    #[test]
    fn ffi_paste_round_trip() {
        let p = tuikit_keys_create();
        feed_ffi(p, b"\x1b[200~");
        feed_ffi(p, b"pasted");
        let buf = feed_ffi(p, b"\x1b[201~");
        let count = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]);
        assert_eq!(count, 1);
        // record 0 at offset 4: kind should be PASTE
        assert_eq!(buf[4], KEY_KIND_PASTE);
        let text_len = u16::from_le_bytes([buf[4 + 6], buf[4 + 7]]);
        let text_ofs = u32::from_le_bytes([buf[4 + 8], buf[4 + 9], buf[4 + 10], buf[4 + 11]]);
        assert_eq!(&buf[text_ofs as usize..(text_ofs as usize + text_len as usize)], b"pasted");
        tuikit_keys_free(p);
    }

    #[test]
    fn null_handle_returns_neg1() {
        let r = keys_feed_impl(std::ptr::null_mut(), b"x".as_ptr(), 1, std::ptr::null_mut(), 0);
        assert_eq!(r, -1);
    }

    #[test]
    fn osc_report_bel_is_swallowed() {
        // Terminal answering an OSC 11 background-colour query, BEL-terminated.
        let ev = run(b"\x1b]11;rgb:2828/2828/2828\x07");
        assert!(ev.is_empty(), "osc report leaked as input: {:?}", ev);
    }

    #[test]
    fn osc_report_st_is_swallowed() {
        // Same reply, ST-terminated (ESC \).
        let ev = run(b"\x1b]11;rgb:2828/2828/2828\x1b\\");
        assert!(ev.is_empty(), "osc report (ST) leaked as input: {:?}", ev);
    }

    #[test]
    fn osc_report_split_across_feeds_is_swallowed() {
        // Worst-case chunking: the reply arrives one byte per feed.
        let ev = run_split(b"\x1b]11;rgb:2828/2828/2828\x07");
        assert!(ev.is_empty(), "split osc report leaked: {:?}", ev);
    }

    #[test]
    fn osc_report_then_typing_survives() {
        // The reply must not eat the keystrokes that follow it.
        let ev = run(b"\x1b]11;rgb:2828/2828/2828\x07hi");
        assert_eq!(ev.len(), 2, "expected the two text events after the report: {:?}", ev);
    }
}
