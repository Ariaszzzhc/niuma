// ===========================================================================
// @niuma/tui — public surface
// ---------------------------------------------------------------------------
// `runTui(deps)` is the entrypoint the CLI calls when it dispatches to the
// interactive TUI. It owns the Terminal lifecycle:
//   1. open the terminal (raw mode + alt-screen + cap detection)
//   2. detect the terminal background colour and pick a theme
//   3. create the live session client (session + open SSE)
//   4. build the TEA program and run it to completion
//   5. restore the terminal and return an exit code
//
// Sources live under `src/` (house style), so internal imports carry the
// `./src/` prefix — exactly how `packages/tuikit/mod.ts` reaches its modules.
//
// Input component currency types are re-exported here. Internal render
// primitives are composed by `app.ts` and are not part of this package's
// public surface.
// ===========================================================================

import { run, Terminal, type TerminalCaps } from "@niuma/tuikit";

// -- theme -------------------------------------------------------------------
import { detectTerminalBg, pickTheme } from "./src/theme.ts";

// -- application -------------------------------------------------------------
import { buildProgram } from "./src/app.ts";
import { createTuiClient, type TuiClient } from "./src/client.ts";

// Re-exports: currency types + factories consumers (the CLI) may want.
export type { AppDeps } from "./src/app.ts";
export {
  createEditorState,
  editorIsEmpty,
  editorReducer,
  editorText,
  renderEditor,
  renderEditorSurface,
  setEditorText,
} from "./src/components/editor.ts";
export type {
  EditorAction,
  EditorCursor,
  EditorState,
  EditorSurface,
  EditorTheme,
} from "./src/components/editor.ts";

export {
  makeApprovalPreview,
  renderApprovalPanel,
  stringifyInput,
} from "./src/components/approval.ts";
export type {
  ApprovalSurface,
  ApprovalTheme,
  ApprovalView,
} from "./src/components/approval.ts";

export {
  BUILTIN_PALETTE_ITEMS,
  closePalette,
  initialPaletteState,
  openPalette,
  paletteFiltered,
  paletteItems,
  paletteReducer,
  renderPalette,
} from "./src/components/palette.ts";
export type {
  PaletteAction,
  PaletteCommandInfo,
  PaletteItem,
  PaletteState,
  PaletteSurface,
  PaletteTheme,
} from "./src/components/palette.ts";

export {
  createQuestionState,
  parseQuestionInput,
  questionReducer,
  renderQuestionPanel,
} from "./src/components/question.ts";
export type {
  QuestionAction,
  QuestionState,
  QuestionSurface,
  QuestionTheme,
} from "./src/components/question.ts";

export { createTuiClient, parseSseStream } from "./src/client.ts";
export type {
  ApprovalDecision,
  ClientCommand,
  ClientResult,
  CompactResult,
  ResumeResult,
  SetEffortResult,
  SetModelResult,
  TuiClient,
  TuiClientOptions,
} from "./src/client.ts";

export {
  BUILTIN_COMMANDS,
  findBuiltinCommand,
  formatSessionList,
  helpLines,
  parseBuiltinCommand,
  resolveSessionId,
  slashCommandCandidates,
} from "./src/commands.ts";
export type {
  BuiltinCommand,
  CompletionCandidate,
  ParsedBuiltinCommand,
  SessionIdResolution,
} from "./src/commands.ts";

export {
  initialCompletionState,
  moveCompletion,
  renderCompletionMenu,
} from "./src/components/completion.ts";
export type {
  CompletionState,
  CompletionTheme,
} from "./src/components/completion.ts";

export {
  initialModelState,
  reduceEvent,
  reduceEventSequence,
} from "./src/reduce_event.ts";
export type {
  NoticeKind,
  PendingApproval,
  SseEvent,
  StreamingText,
  ToolCallStatus,
  TuiMessage,
  TuiModelState,
  TuiNotice,
  TuiRole,
  TuiToolCall,
} from "./src/reduce_event.ts";

export { buildProgram } from "./src/app.ts";

// ---------------------------------------------------------------------------
// runTui
// ---------------------------------------------------------------------------

export interface RunTuiDeps {
  /** Tunnelled fetch (same shape the one-shot runner uses). */
  readonly fetchImpl: typeof fetch;
  readonly workspace: string;
  /** Bare model id recorded on the session; omit for the mock provider. */
  readonly model?: string;
  /** Existing Session Journal to resume in the current Workspace. */
  readonly resume?: string;
  /** Version string shown in the banner. */
  readonly version: string;
}

/**
 * Boot the interactive TUI against a tunnelled server. Enters the alt-screen,
 * runs the TEA program until it quits, restores the terminal, and returns an
 * exit code (0 on clean quit, 1 on a boot/runtime fault that escapes `run`).
 */
export const runTui = async (deps: RunTuiDeps): Promise<number> => {
  let terminal: Terminal | null = null;
  try {
    terminal = Terminal.open();
    const caps: TerminalCaps = terminal.caps;
    const bg = await detectTerminalBg(terminal, 300);
    const theme = pickTheme(bg, caps);

    let client: TuiClient;
    try {
      client = await createTuiClient(deps.fetchImpl, {
        workspace: deps.workspace,
        ...(deps.model !== undefined ? { model: deps.model } : {}),
        ...(deps.resume !== undefined ? { resume: deps.resume } : {}),
      });
    } catch (err) {
      console.error(
        `niuma: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }

    const program = buildProgram({
      client,
      theme,
      version: deps.version,
      workspace: deps.workspace,
      size: terminal.size,
    });

    await run(terminal, program);
    return 0;
  } catch (err) {
    console.error(
      `niuma: tui error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  } finally {
    try {
      terminal?.dispose();
    } catch {
      // best-effort restore
    }
  }
};
