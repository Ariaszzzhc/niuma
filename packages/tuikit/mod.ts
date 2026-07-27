// ===========================================================================
// @niuma/tuikit — public API surface
// ---------------------------------------------------------------------------
// Re-exports the implemented primitives (Frame / KeyParser / Terminal / run /
// width / style helpers) and the currency types + constant tables. The FFI
// internals (ffi.ts dlopen wiring, buffer.ts pool) are intentionally NOT
// re-exported. `binding_contract.ts` feeds the public wrappers but remains an
// internal implementation module.
//
// `binding_contract.ts` contains only ABI constants/layouts and shared
// currency types. Runtime APIs come from their implementation modules below.
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
  MouseButton,
  MouseEvent,
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
  MOUSE_BUTTON,
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
