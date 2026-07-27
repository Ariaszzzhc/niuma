// ===========================================================================
// @niuma/tuikit — declarative screen view
// ---------------------------------------------------------------------------
// A TEA program returns a View rather than performing terminal side effects.
// The line grid remains the renderer's primary currency; the optional cursor
// lets editors use the terminal's real caret (important for IME candidate
// placement) without owning cursor escape sequences themselves.
// ===========================================================================

import type { StyledLine } from "./binding_contract.ts";

/** Hardware cursor declared by a View. Coordinates are zero-based cells. */
export type CursorShape = "block" | "underline" | "bar";
export interface Cursor {
  readonly row: number;
  readonly col: number;
  readonly shape?: CursorShape;
}

/** Declarative full-screen result of a TEA program's view function. */
export interface View {
  readonly lines: readonly StyledLine[];
  readonly cursor?: Cursor;
}

/** Convenience constructor used by simple programs and tests. */
export const screen = (
  lines: readonly StyledLine[],
  cursor?: Cursor,
): View => cursor === undefined ? { lines } : { lines, cursor };
