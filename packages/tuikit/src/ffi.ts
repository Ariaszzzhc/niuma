// ===========================================================================
// @niuma/tuikit — FFI wiring (Deno.dlopen)
// ---------------------------------------------------------------------------
// Owns the single `Deno.dlopen` call against `libniuma_tuikit`, platform
// library-path resolution relative to this source file, a memoized singleton
// open, and the `TuikitError` raised whenever a native function returns its
// panic sentinel (-1 / null handle).
//
// The symbol table itself lives in `binding-contract.ts` (SYMBOLS) and is the
// authoritative mirror of `native/src/abi.rs`. This module MUST NOT invent or
// rename symbols — it only opens what the contract declares.
//
// dlopen is runtime: `deno check` / `deno compile` never touch the library,
// so the whole package type-checks even before `cargo build --release`. The
// library is only needed when an FFI symbol is actually called.
// ===========================================================================

import { dirname, fromFileUrl, join } from "@std/path";
import { SYMBOLS, type TuikitLib } from "./binding-contract.ts";

// ---------------------------------------------------------------------------
// Library path resolution
// ---------------------------------------------------------------------------

/**
 * Compiled cdylib filename, platform-dependent. Cargo prefixes the crate
 * name with `lib` on Unix targets but not on Windows:
 *   darwin  -> libniuma_tuikit.dylib
 *   windows -> niuma_tuikit.dll
 *   linux / android / freebsd / netbsd / aix / solaris -> libniuma_tuikit.so
 */
const libFileName = (): string => {
  switch (Deno.build.os) {
    case "darwin":
      return "libniuma_tuikit.dylib";
    case "windows":
      return "niuma_tuikit.dll";
    default:
      return "libniuma_tuikit.so";
  }
};

/**
 * Absolute path to the release cdylib, resolved relative to this file
 * (`packages/tuikit/src/ffi.ts` -> `packages/tuikit/native/target/release/`).
 * `import.meta.url` keeps this correct regardless of the caller's cwd.
 */
export const libPath = (): string => {
  const srcDir = dirname(fromFileUrl(import.meta.url)); // .../packages/tuikit/src
  const pkgRoot = join(srcDir, ".."); // .../packages/tuikit
  return join(pkgRoot, "native", "target", "release", libFileName());
};

// ---------------------------------------------------------------------------
// Memoized open
// ---------------------------------------------------------------------------

let cached: TuikitLib | null = null;

/** True when the cdylib artifact exists at {@link libPath}. */
const libExists = (path: string): boolean => {
  try {
    return Deno.statSync(path).isFile === true;
  } catch {
    return false;
  }
};

/**
 * Open the native library (memoized). Throws a `TuikitError` with an
 * actionable build command when the artifact is missing — this is the single
 * place that explains "where do I get the dylib from".
 *
 * Re-throws any underlying dlopen failure verbatim (missing symbols, wrong
 * arch, etc.) prefixed with context.
 */
export const openLib = (): TuikitLib => {
  if (cached) return cached;
  const path = libPath();
  if (!libExists(path)) {
    throw new TuikitError(
      "dlopen",
      `native library not found at:\n    ${path}\n` +
        `  Build it first — run:\n    cd packages/tuikit/native && cargo build --release`,
    );
  }
  let lib: TuikitLib;
  try {
    lib = Deno.dlopen(path, SYMBOLS);
  } catch (cause) {
    throw new TuikitError(
      "dlopen",
      `failed to load native library at ${path}`,
      { cause },
    );
  }
  cached = lib;
  return lib;
};

/** Convenience: the typed symbol table of the open library. */
export const symbols = () => openLib().symbols;

// ---------------------------------------------------------------------------
// Errors + result guards
// ---------------------------------------------------------------------------

/**
 * Raised when a native function returns its panic sentinel (-1 for integer
 * results, null for handle results) or when the library cannot be loaded.
 * `op` identifies the FFI operation for diagnostics.
 */
export class TuikitError extends Error {
  readonly op: string;
  constructor(op: string, message?: string, options?: { cause?: unknown }) {
    super(message ?? `@niuma/tuikit: native op '${op}' faulted (-1)`, options);
    this.name = "TuikitError";
    this.op = op;
  }
}

/**
 * Normalise a native i64/u64 result. Deno returns these as `bigint`; values
 * here (widths, byte counts, palette indices) always fit in a safe integer.
 * Throws `TuikitError` on a -1 fault.
 */
export const checkI64 = (op: string, v: number | bigint): number => {
  const n = typeof v === "bigint" ? Number(v) : v;
  if (!Number.isFinite(n) || n < 0) throw new TuikitError(op);
  return n;
};

/**
 * Normalise a native handle result. Deno expresses null handles as `null` or
 * a zero bigint (PointerValue is `PointerObject | bigint`; the PointerObject
 * form is never null-ish, so we only need to reject null/undefined and 0n).
 */
export const checkHandle = (op: string, h: Deno.PointerValue): Deno.PointerValue => {
  if (h === null || h === undefined) throw new TuikitError(op);
  if (typeof h === "bigint" && h === 0n) throw new TuikitError(op);
  return h;
};

/**
 * Convert any PointerValue (bigint or object form) to a bigint address. Used
 * when a pointer must be stored in a binary record field (u64) — span text
 * pointers, gradient text pointers.
 */
export const ptrToBigInt = (p: Deno.PointerValue): bigint => {
  if (p === null || p === undefined) return 0n;
  if (typeof p === "bigint") return p;
  // Object-form pointer (PointerObject): unwrap to its numeric address.
  return Deno.UnsafePointer.value(p);
};

/**
 * Take a raw pointer to a `Uint8Array` for an FFI call. TS 5.7+ made
 * `Uint8Array` generic over its backing buffer (`Uint8Array<ArrayBufferLike>`),
 * and `Deno.UnsafePointer.of` rejects the `SharedArrayBuffer` widening — every
 * buffer we allocate is `ArrayBuffer`-backed, so the cast is sound. Keeping the
 * cast in one place avoids sprinkling `as` at every call site.
 */
export const ptrOf = (view: Uint8Array): Deno.PointerValue =>
  Deno.UnsafePointer.of(view as Uint8Array<ArrayBuffer>);
