// ===========================================================================
// @niuma/tuikit — public API surface
// ---------------------------------------------------------------------------
// Re-exports the implemented primitives (Frame / KeyParser / Terminal / run /
// width / style helpers) and the currency types + constant tables. The FFI
// internals (ffi.ts dlopen wiring, buffer.ts pool) are intentionally NOT
// re-exported; advanced users who need the raw ABI still reach for
// `binding-contract.ts` directly.
//
// NOTE: `binding-contract.ts` carries ambient `declare` placeholders for the
// runtime symbols (run / Frame / Terminal / openLib / ...) that this package
// implements for real in loop.ts / frame.ts / terminal.ts / ffi.ts. We
// therefore export the IMPLEMENTATIONS here, and only the types + constant
// tables from the contract — never the ambient declares (which would clash).
// ===========================================================================

// -- currency types + constant tables (from the contract) -------------------
export type {
  Color,
  Style,
  StyledSpan,
  StyledLine,
  TerminalCaps,
  KeyMods,
  NamedKey,
  KeyKind,
  KeyEventType,
  KeyCode,
  KeyEvent,
  PasteEvent,
  InputEvent,
} from "./src/binding-contract.ts";

export {
  COLOR_TAG,
  ATTR,
  CAP,
  KEY_KIND,
  KEY_EVENT_TYPE,
  MOD,
  KEY_CODE,
} from "./src/binding-contract.ts";

// -- implemented primitives --------------------------------------------------
export { Frame } from "./src/frame.ts";
export { KeyParser, matchesKey } from "./src/keys.ts";
export { Terminal, detectCaps, SYNC_BEGIN, SYNC_END } from "./src/terminal.ts";
export type { TerminalSize } from "./src/terminal.ts";
export { stringWidth, truncateToWidth } from "./src/width.ts";
export { styleToSgr, rgbTo256, rgbTo16, quantizeColor, gradient } from "./src/style.ts";
export { run, cmd, tick } from "./src/loop.ts";
export type {
  Cmd,
  Sub,
  Program,
  LoopMsg,
  KeyMsg,
  ResizeMsg,
  TickMsg,
  ErrorMsg,
} from "./src/loop.ts";
