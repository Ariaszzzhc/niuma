//! # niuma_tuikit — native hot-path core for `@niuma/tuikit`
//!
//! This crate is the data-dense, IO-free side of the TUI: display-width,
//! cell buffer, frame diffing, keyboard parsing and ANSI/SGR generation. It
//! is compiled to a `cdylib` (`libniuma_tuikit.{dylib,so,dll}`) loaded by the
//! TypeScript layer via `Deno.dlopen`.
//!
//! ## Layout
//!
//! - [`abi`] — the *entire* `extern "C"` surface, the binary record layouts,
//!   and the tagged color / attr / caps / key constants. It is the single
//!   source of truth mirrored by `packages/tuikit/src/binding-contract.ts`.
//! - [`width`] — EAW interval table + hand-written grapheme clustering.
//! - [`cellbuf`] — `Frame` / `Cell` and `write_line` clipping.
//! - [`diff`] — minimal-output frame diff and full paint.
//! - [`keys`] — incremental byte-stream keyboard state machine.
//! - [`sgr`] — SGR emission and color quantization.
//!
//! Every `extern "C"` fn lives in [`abi`] and is wrapped in `catch_unwind` so
//! a panic NEVER crosses the FFI boundary (it returns `-1` / null instead).
//!
//! There are intentionally **zero** external crates.
//!
//! `lib.rs` only declares the modules; it emits no symbols of its own.

#![allow(clippy::missing_safety_doc)]

pub mod abi;
pub mod cellbuf;
pub mod diff;
pub mod keys;
pub mod sgr;
pub mod width;
