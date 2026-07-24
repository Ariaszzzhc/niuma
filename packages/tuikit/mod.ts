// ===========================================================================
// @niuma/tuikit — public API surface
// ---------------------------------------------------------------------------
// Re-exports the implemented primitives (Frame / KeyParser / Terminal / run /
// width / style helpers) and the currency types + constant tables. The FFI
// internals (ffi.ts dlopen wiring, buffer.ts pool) are intentionally NOT
// re-exported; advanced users who need the raw ABI still reach for
// `binding_contract.ts` directly.
//
// NOTE: `binding_contract.ts` carries ambient `declare` placeholders for the
// runtime symbols (run / Frame / Terminal / openLib / ...) that this package
// implements for real in loop.ts / frame.ts / terminal.ts / ffi.ts. We
// therefore export the IMPLEMENTATIONS here, and only the types + constant
// tables from the contract — never the ambient declares (which would clash).
// ===========================================================================

// -- currency types + constant tables (from the contract) -------------------
export type {
  Color,
  InputEvent,
  KeyCode,
  KeyEvent,
  KeyEventType,
  KeyKind,
  KeyMods,
  NamedKey,
  PasteEvent,
  Style,
  StyledLine,
  StyledSpan,
  TerminalCaps,
} from "./src/binding_contract.ts";

export {
  ATTR,
  CAP,
  COLOR_TAG,
  KEY_CODE,
  KEY_EVENT_TYPE,
  KEY_KIND,
  MOD,
} from "./src/binding_contract.ts";

// -- implemented primitives --------------------------------------------------
export { Frame } from "./src/frame.ts";
export { KeyParser, matchesKey } from "./src/keys.ts";
export { detectCaps, SYNC_BEGIN, SYNC_END, Terminal } from "./src/terminal.ts";
export type { TerminalSize } from "./src/terminal.ts";
export { stringWidth, truncateToWidth } from "./src/width.ts";
export {
  gradient,
  quantizeColor,
  rgbTo16,
  rgbTo256,
  styleToSgr,
} from "./src/style.ts";
export { cmd, run, tick } from "./src/loop.ts";
export type {
  Cmd,
  ErrorMsg,
  KeyMsg,
  LoopMsg,
  Program,
  ResizeMsg,
  Sub,
  TickMsg,
} from "./src/loop.ts";
