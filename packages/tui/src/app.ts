// ===========================================================================
// @niuma/tui — the TEA Program (app.ts, INPUT/ORCHESTRATION half)
// ---------------------------------------------------------------------------
// Wires the input components (editor / palette / approval / completion menu)
// and the SSE reducer (`reduce_event.ts`) into one `Program<AppModel, Msg>`
// for `@niuma/tuikit`'s `run`. Owns the full-screen layout (transcript /
// statusline / editor), stamps the slash-command completion menu above the
// editor, and overlays the palette + approval modal on a dimmed base scene.
//
// INTERLOCK (A-side, owned by a parallel agent — imported, not stubbed):
//   - renderTranscript(state: TranscriptState, w, h, theme)       [transcript.ts]
//   - renderToolCall(call: ToolCallView, w, theme)                [tool_call.ts]
//   - renderStatusline(view: StatusView, w, theme)                [statusline.ts]
//   - Theme / pickTheme / detectTerminalBg                        [theme.ts]
// This file ADAPTS this package's data model (`TuiModelState` from
// reduce_event.ts) into the view-models those renderers expect. The exact
// field shapes of `TranscriptState` / `ToolCallView` / `StatusView` are the
// reconciliation surface; `app.ts` therefore type-checks only once the A-side
// modules land with matching shapes (expected mid-run friction).
// ===========================================================================

import {
  type Cmd,
  cmd,
  type Color,
  type LoopMsg,
  matchesKey,
  MOUSE_BUTTON,
  type Program,
  type StyledLine,
  type StyledSpan,
  type Sub,
  tick,
} from "@niuma/tuikit";

// -- B-side (this package) ---------------------------------------------------
import {
  createEditorState,
  editorIsEmpty,
  editorReducer,
  editorText,
  type EditorState,
  renderEditor,
  setEditorText,
} from "./components/editor.ts";
import {
  APPROVAL_OPTIONS,
  type ApprovalView,
  makeApprovalPreview,
  renderApprovalOverlay,
  stringifyInput,
} from "./components/approval.ts";
import {
  closePalette,
  initialPaletteState,
  type PaletteItem,
  paletteItems,
  paletteReducer,
  type PaletteState,
  renderPalette,
} from "./components/palette.ts";
import {
  initialModelState,
  nextEventId,
  reduceEvent,
  reduceEventSequence,
  type SseEvent,
  type TuiToolCall,
} from "./reduce_event.ts";
import {
  type ApprovalDecision,
  parseSseStream,
  type TuiClient,
} from "./client.ts";
import {
  type CompletionCandidate,
  formatSessionList,
  helpLines,
  parseBuiltinCommand,
  resolveSessionId,
  slashCommandCandidates,
} from "./commands.ts";
import {
  type CompletionState,
  initialCompletionState,
  moveCompletion,
  renderCompletionMenu,
} from "./components/completion.ts";
import type { RecordedEvent, SessionInfo } from "@niuma/schema";

// -- A-side view layer (parallel agent) --------------------------------------
// Imported by signature; shapes reconciled against the landed modules.
import type { Theme } from "./theme.ts";
import {
  type ChatMessage,
  renderTranscript,
  transcriptContentHeight,
  type TranscriptMsg,
  transcriptReducer,
  type TranscriptState,
} from "./components/transcript.ts";
import type { ToolCallView } from "./components/tool_call.ts";
import {
  type GitStatus,
  renderStatusline,
  type StatusView,
} from "./components/statusline.ts";

// ---------------------------------------------------------------------------
// Local theme adapters (EditorTheme / ApprovalTheme / PaletteTheme -> Theme)
// ---------------------------------------------------------------------------

/** Semantic colors the input components need, derived from the A-side Theme.
 *  `placeholder`/`prompt` have no direct Theme slot, so we reuse textDim /
 *  accent (the closest semantic match). */
interface ThemeColors {
  readonly border: Color;
  readonly accent: Color;
  readonly text: Color;
  readonly muted: Color;
  readonly warning: Color;
  readonly prompt: Color;
  readonly placeholder: Color;
}

const themeColors = (theme: Theme): ThemeColors => ({
  border: theme.border,
  accent: theme.accent,
  text: theme.text,
  muted: theme.muted,
  warning: theme.warning,
  prompt: theme.accent,
  placeholder: theme.textDim,
});

// ---------------------------------------------------------------------------
// Msg union (loop messages + app messages)
// ---------------------------------------------------------------------------

type SseMsg = { readonly type: "tui:sse"; readonly event: SseEvent };
type PromptedMsg = {
  readonly type: "tui:prompted";
  readonly ok: boolean;
  readonly status: number;
  readonly body: string;
};
type ApprovalReplyMsg = { readonly type: "tui:approval"; readonly ok: boolean };
type InterruptDoneMsg = {
  readonly type: "tui:interrupt";
  readonly ok: boolean;
};
type GitTickMsg = { readonly type: "tuikit:git-tick"; readonly n: number };
type GitMsg = { readonly type: "tui:git"; readonly status: GitStatus | null };
type QuitMsg = { readonly type: "tui:quit" };

/** Async outcome of a built-in slash command, delivered back into update.
 *  The Cmd performs the client call; the reducer applies state + notices so
 *  the whole dispatch stays testable through `update`. */
type CommandOutcome =
  | {
    readonly kind: "model";
    readonly ok: boolean;
    readonly ref: string;
    readonly model?: string;
    readonly contextWindow?: number;
    readonly error?: string;
  }
  | {
    readonly kind: "effort";
    readonly ok: boolean;
    readonly ref: string;
    readonly effort?: string;
    readonly error?: string;
  }
  | {
    readonly kind: "compact";
    readonly ok: boolean;
    readonly code?: string;
    readonly error?: string;
  }
  | { readonly kind: "clear"; readonly ok: boolean; readonly error?: string }
  | {
    readonly kind: "sessions";
    readonly ok: boolean;
    readonly sessions?: readonly SessionInfo[];
    readonly error?: string;
  }
  | {
    readonly kind: "resume";
    readonly ok: boolean;
    readonly info?: SessionInfo;
    readonly history?: ReadonlyArray<RecordedEvent>;
    readonly error?: string;
  };
type CommandResultMsg = {
  readonly type: "tui:command";
  readonly outcome: CommandOutcome;
};

type Msg =
  | LoopMsg
  | SseMsg
  | PromptedMsg
  | ApprovalReplyMsg
  | InterruptDoneMsg
  | GitTickMsg
  | GitMsg
  | QuitMsg
  | CommandResultMsg;

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

interface AppModel {
  readonly state: ReturnType<typeof initialModelState>;
  readonly editor: EditorState;
  readonly palette: PaletteState;
  /** Slash-command completion popup state (selection + esc dismissal). */
  readonly completion: CompletionState;
  readonly approval: ApprovalView | null;
  readonly spinnerFrame: number;
  /** Git state for the workspace, refreshed by a periodic probe Cmd. */
  readonly gitStatus: GitStatus | null;
  /** Scroll offset (rendered lines from the top). Authoritative only while
   * `followTail` is false; ignored (pinned to bottom) while following. */
  readonly transcriptScroll: number;
  /** When true the transcript stays glued to the newest content. Any scroll up
   * breaks follow; scrolling back to the exact bottom re-engages it. This is
   * the authoritative flag (not re-derived from the offset) so an incoming SSE
   * event never re-pins a view the user scrolled up. */
  readonly followTail: boolean;
  readonly quitting: boolean;
  readonly lastCtrlC: number;
  /** Thinking effort set via /effort (TUI-local mirror of the server-side
   * setting). undefined = the model's own default; reset on session switch. */
  readonly effort: string | undefined;
  readonly width: number;
  readonly height: number;
}

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

// The app advances `spinnerFrame` on each TickMsg; the A-side statusline and
// tool_call components map that index to a braille glyph themselves, so no
// frame table is needed here.

// ---------------------------------------------------------------------------
// Program factory
// ---------------------------------------------------------------------------

export interface AppDeps {
  readonly client: TuiClient;
  readonly theme: Theme;
  readonly version: string;
  readonly workspace: string;
  readonly size: { readonly cols: number; readonly rows: number };
}

export const buildProgram = (deps: AppDeps): Program<AppModel, Msg> => {
  const { client, theme } = deps;
  const colors = themeColors(theme);
  // Built-in UI commands + this session's custom slash commands (from the
  // session-create response); fixed for the app's lifetime.
  const paletteItemList = paletteItems(client.commands);

  const initialModel: AppModel = {
    state: initialModelState(),
    editor: createEditorState(),
    palette: initialPaletteState,
    completion: initialCompletionState,
    approval: null,
    spinnerFrame: 0,
    gitStatus: null,
    transcriptScroll: 0,
    followTail: true,
    quitting: false,
    lastCtrlC: 0,
    effort: undefined,
    width: deps.size.cols,
    height: deps.size.rows,
  };

  // -- subscriptions: spinner tick + SSE pump + git probe -------------------
  const spinnerSub: Sub<Msg> = tick(80, (n) =>
    ({
      type: "tuikit:tick",
      n,
    }) as Msg);

  // Slow tick driving the git probe: branch + dirty state change only on
  // user/git actions outside the TUI, so a 2s cadence is plenty fresh. The
  // probe itself runs inside a Cmd (async, off the update path).
  const GIT_PROBE_MS = 2000;
  const gitTickSub: Sub<Msg> = tick(
    GIT_PROBE_MS,
    (n) => ({ type: "tuikit:git-tick", n }) as Msg,
  );

  // SSE pump with session-switch support: tuikit calls `subscriptions()` once,
  // so the Sub itself watches `client.streamVersion` (bumped by newSession /
  // resume — the /clear and /resume commands) and swaps pumps when it changes.
  // Each pump owns an explicit reader so teardown cancels the underlying fetch
  // body (a flag-only cancel would leave the old connection parked on a read
  // until the next server frame).
  const sseSub: Sub<Msg> = {
    subscribe: (emit) => {
      let disposed = false;
      let pumpVersion = -1;
      let cancelPump: (() => void) | null = null;

      const startPump = (): void => {
        pumpVersion = client.streamVersion;
        const reader = client.eventsStream.getReader();
        // Bridge so parseSseStream can lock its own reader while WE keep the
        // real one for cancellation.
        const bridge = new ReadableStream<Uint8Array>({
          pull: async (controller) => {
            const { value, done } = await reader.read();
            if (done) controller.close();
            else if (value !== undefined) controller.enqueue(value);
          },
          cancel: (reason) => reader.cancel(reason),
        });
        let cancelled = false;
        (async () => {
          try {
            for await (const frame of parseSseStream(bridge)) {
              if (cancelled) break;
              if (frame.event === "ping") continue;
              if (frame.data.length === 0) continue;
              let payload: { type?: string; data?: Record<string, unknown> };
              try {
                payload = JSON.parse(frame.data);
              } catch {
                continue;
              }
              const event: SseEvent = {
                type: payload.type ?? frame.event ?? "",
                data: payload.data ?? {},
              };
              emit({ type: "tui:sse", event });
            }
          } catch {
            // stream closed / errored — the turn-aborted path handles UI.
          }
        })();
        cancelPump = () => {
          cancelled = true;
          void reader.cancel().catch(() => {});
        };
      };

      startPump();
      const poll = setInterval(() => {
        if (disposed) return;
        if (client.streamVersion !== pumpVersion) {
          cancelPump?.();
          startPump();
        }
      }, 100);

      return () => {
        disposed = true;
        clearInterval(poll);
        cancelPump?.();
      };
    },
  };

  // -- helpers ------------------------------------------------------------

  // Local notices share reduce_event's id counter so the view can merge them
  // with SSE-produced messages/notices back into chronological order.
  const notice = (text: string, kind: "info" | "error" = "info") => ({
    id: nextEventId("n"),
    kind,
    text,
  });

  /** Append a notice to the model's state (command feedback channel). */
  const withNotice = (
    model: AppModel,
    text: string,
    kind: "info" | "error" = "info",
  ): AppModel => ({
    ...model,
    state: {
      ...model.state,
      notices: [...model.state.notices, notice(text, kind)],
    },
  });

  /** Map our TuiToolCall to the A-side ToolCallView (structural interlock).
   *  `denied` maps to `error`; `durationMs` is omitted while still running. */
  const toToolCallView = (c: TuiToolCall): ToolCallView => {
    const status: ToolCallView["status"] = c.status === "running"
      ? "running"
      : c.status === "denied"
      ? "error"
      : "done";
    const view: ToolCallView = {
      name: c.name,
      status,
      inputSummary: stringifyInput(c.input, 120),
      resultLines: c.resultLines,
      expanded: c.expanded,
    };
    return c.status === "running"
      ? view
      : { ...view, durationMs: c.durationMs };
  };

  /**
   * Compute the on-screen row budget for the transcript / statusline / editor.
   * Shared by `view` and the scroll handler so they agree on the transcript
   * viewport height (the reducer needs it to clamp scroll offsets). Layout:
   * 1-row statusline, editor = 2 borders + up to 5 content rows, transcript
   * takes the rest. (The startup banner was removed — the transcript owns the
   * top of the screen from the first frame.)
   */
  const computeLayout = (
    model: AppModel,
  ): { readonly transcriptH: number; readonly editorH: number } => {
    const H = Math.max(1, model.height);
    const editorContentRows = Math.min(
      5,
      Math.max(1, model.editor.lines.length),
    );
    const editorH = editorContentRows + 2;
    const statusH = 1;
    const transcriptH = Math.max(0, H - statusH - editorH);
    return { transcriptH, editorH };
  };

  /**
   * Build the A-side TranscriptState from our model (structural interlock).
   *
   * `followTail` / `scrollOffset` are the AUTHORITATIVE scroll fields stored on
   * the model (advanced only by `applyTranscriptScroll` / reset on esc+clear).
   * They are passed through verbatim — never re-derived from the offset — so an
   * incoming SSE event while the user is scrolled up cannot re-pin the view.
   *
   * INTERLEAVING NOTE: messages and notices are merged chronologically via
   * the shared id counter (see below); tool calls still live in a separate
   * array and are appended after the text/notice timeline, and the live
   * streaming text goes last. Perfect message/tool interleaving would need
   * a single ordered timeline in reduce_event (future refinement).
   */
  const buildTranscriptMessages = (model: AppModel): ChatMessage[] => {
    // Messages and notices share reduce_event's id counter, so the numeric
    // id suffix is a total chronological order across both channels — merge
    // by it instead of appending notices at the end.
    const seqOf = (id: string): number => {
      const n = Number(id.replace(/^[^\d]+/, ""));
      return Number.isFinite(n) ? n : 0;
    };
    const timed: Array<{ seq: number; msg: ChatMessage }> = [
      ...model.state.messages.map((m) => ({
        seq: seqOf(m.id),
        msg: m.role === "user"
          ? { role: "user", text: m.text } as ChatMessage
          : {
            role: "assistant",
            text: m.text,
            thinking: m.thinking,
          } as ChatMessage,
      })),
      ...model.state.notices.map((n) => ({
        seq: seqOf(n.id),
        msg: { role: "notice", text: n.text, kind: n.kind } as ChatMessage,
      })),
    ];
    timed.sort((a, b) => a.seq - b.seq);
    const toolMsgs: ChatMessage[] = model.state.toolCalls.map(
      (c): ChatMessage => ({ role: "tool", call: toToolCallView(c) }),
    );
    let messages: ChatMessage[] = [...timed.map((t) => t.msg), ...toolMsgs];
    const streaming = model.state.streaming;
    if (
      streaming && (streaming.text.length > 0 || streaming.thinking.length > 0)
    ) {
      messages = [
        ...messages,
        {
          role: "assistant",
          text: streaming.text,
          thinking: streaming.thinking,
        },
      ];
    }
    return messages;
  };

  const toTranscriptState = (model: AppModel): TranscriptState => ({
    messages: buildTranscriptMessages(model),
    scrollOffset: model.transcriptScroll,
    followTail: model.followTail,
  });

  /**
   * The transcript viewport height for the current model, replicating the
   * `view`'s layout (banner cap 3 + statusline 1 + editor 2+content). Shared by
   * the scroll handler so its clamp math matches what is actually on screen.
   */
  const transcriptViewportHeight = (model: AppModel): number => {
    return computeLayout(model).transcriptH;
  };

  /**
   * Apply a transcript scroll message via the pure `transcriptReducer`, giving
   * it the live content + viewport height so offsets clamp and "scrolled back
   * to the bottom" re-engages follow. Returns a model with the updated
   * `transcriptScroll` / `followTail`.
   */
  const applyTranscriptScroll = (
    model: AppModel,
    msg: TranscriptMsg,
  ): AppModel => {
    const ts = toTranscriptState(model);
    const W = Math.max(1, model.width);
    const contentLines = transcriptContentHeight(ts, W, theme, {
      spinnerFrame: model.spinnerFrame,
      streaming: model.state.streaming !== null,
    });
    const viewportHeight = transcriptViewportHeight(model);
    const next = transcriptReducer(ts, msg, { contentLines, viewportHeight });
    return {
      ...model,
      transcriptScroll: next.scrollOffset,
      followTail: next.followTail,
    };
  };

  const toStatusView = (model: AppModel): StatusView => ({
    model: model.state.model ?? "",
    tokensIn: model.state.tokensIn,
    tokensOut: model.state.tokensOut,
    lastInputTokens: model.state.lastInputTokens,
    contextWindow: model.state.contextWindow ?? client.contextWindow,
    cwd: deps.workspace,
    git: model.gitStatus,
    // The MCP list is known the moment the session was created (client) OR
    // when session.created replays over SSE — whichever landed first. null
    // means "handshake still pending" and animates in the status line.
    mcpServers: client.mcpServers.length > 0
      ? client.mcpServers
      : model.state.mcpServers.length > 0
      ? model.state.mcpServers
      : model.state.sessionId === null && model.state.model === null
      ? null
      : [],
    activity: model.state.turnActive
      ? (model.state.streaming !== null
        ? model.state.streaming.text.length > 0 ? "generating" : "thinking"
        : "working")
      : null,
    spinnerFrame: model.spinnerFrame,
  });

  // -- key handling -------------------------------------------------------

  const handleKey = (
    model: AppModel,
    event: import("@niuma/tuikit").InputEvent,
  ): readonly [AppModel, ...Cmd<Msg>[]] => {
    // 1) approval modal takes INPUT priority (it is also painted on top in the
    //    view): it captures y / a / n, arrow-key navigation + enter, the digit
    //    shortcuts 1..3, and esc; everything else is swallowed while it is up.
    //    This MUST come before the palette so an approval arriving while
    //    the palette is open cannot have its y/a/n swallowed by the palette
    //    query (overlay priority and input priority then agree).
    if (model.approval !== null) {
      const approval = model.approval;
      const dispatch = (
        m: AppModel,
        decision: ApprovalDecision,
        feedback?: string,
      ): readonly [AppModel, ...Cmd<Msg>[]] => {
        const approvalId = approval.approvalId;
        const cleared: AppModel = { ...m, approval: null };
        return [
          cleared,
          cmd(async () => {
            const r = await client.approve(approvalId, decision, feedback);
            return { type: "tui:approval", ok: r.ok } as Msg;
          }),
        ];
      };
      // navigation: up/down (or left/right) move the highlight; enter confirms
      // the highlighted option; 1..3 pick directly; y/a/n keep working.
      if (event.kind === "key") {
        if (event.key === "up" || event.key === "left") {
          const selection = (approval.selection - 1 + APPROVAL_OPTIONS.length) %
            APPROVAL_OPTIONS.length;
          return [{ ...model, approval: { ...approval, selection } }];
        }
        if (event.key === "down" || event.key === "right") {
          const selection = (approval.selection + 1) % APPROVAL_OPTIONS.length;
          return [{ ...model, approval: { ...approval, selection } }];
        }
        if (event.key === "enter") {
          const opt = APPROVAL_OPTIONS[approval.selection];
          return dispatch(model, opt.decision as ApprovalDecision);
        }
      }
      const decision = approvalDecision(event);
      if (decision !== null) {
        return dispatch(model, decision.decision, decision.feedback);
      }
      return [model]; // swallow everything else while the modal is up
    }

    // 2) palette: when OPEN it owns input (the completion menu is derived
    //    from the editor buffer, which the palette freezes, so the two never
    //    compete). The closed-palette ctrl+p open is handled at 4), AFTER the
    //    completion menu — a live menu gets ctrl+p first (menu navigation).
    if (model.palette.open) {
      const [paletteNext, paletteAction] = paletteReducer(
        model.palette,
        event,
        paletteItemList,
      );
      let m: AppModel = { ...model, palette: paletteNext };
      if (paletteAction?.type === "execute") {
        const [next, ...cmds] = runPaletteCommand(m, paletteAction.item);
        m = next;
        return [m, ...cmds];
      }
      return [m];
    }

    // 3) completion menu: auto-pops on a `/partial` token. Navigation keys
    //    (up/down + ctrl+p/ctrl+n) move the selection; tab accepts (fills
    //    `/name `); enter accepts AND submits; esc dismisses the menu for the
    //    current token (buffer edits re-arm it). Anything else falls through
    //    to the normal pipeline — text edits reach the editor at 8), ctrl+c
    //    keeps its global meaning at 5).
    const menu = completionMenu(model);
    if (menu !== null) {
      if (event.kind === "key") {
        if (event.key === "up" || event.key === "down") {
          return [{
            ...model,
            completion: moveCompletion(
              model.completion,
              menu.items.length,
              event.key === "up" ? -1 : 1,
            ),
          }];
        }
        if (event.key === "tab") return acceptCompletion(model, menu, false);
        if (event.key === "enter") return acceptCompletion(model, menu, true);
      }
      if (event.kind === "text") {
        if (matchesKey(event, "ctrl+p")) {
          return [{
            ...model,
            completion: moveCompletion(model.completion, menu.items.length, -1),
          }];
        }
        if (matchesKey(event, "ctrl+n")) {
          return [{
            ...model,
            completion: moveCompletion(model.completion, menu.items.length, 1),
          }];
        }
      }
      if (event.kind === "esc") {
        return [{
          ...model,
          completion: { ...model.completion, dismissed: true },
        }];
      }
    }

    // 4) closed palette: ctrl+p opens it (only reached with no live menu).
    {
      const [paletteNext, paletteAction] = paletteReducer(
        model.palette,
        event,
        paletteItemList,
      );
      if (paletteNext.open || paletteAction !== undefined) {
        let m: AppModel = { ...model, palette: paletteNext };
        if (paletteAction?.type === "execute") {
          const [next, ...cmds] = runPaletteCommand(m, paletteAction.item);
          m = next;
          return [m, ...cmds];
        }
        return [m];
      }
    }

    // 5) ctrl+d: quit when the editor is empty (readline-style EOF), with the
    //    same double-press-confirm as ctrl+c. When the editor has content the
    //    key falls through to the editor, which swallows ctrl-prefixed text
    //    events (matching the previous behavior).
    if (matchesKey(event, "ctrl+d") && editorIsEmpty(model.editor)) {
      const now = Date.now();
      if (now - model.lastCtrlC < 500) {
        return [{ ...model, quitting: true }];
      }
      return [
        {
          ...model,
          lastCtrlC: now,
          state: {
            ...model.state,
            notices: [
              ...model.state.notices,
              notice("press ctrl+d again to quit"),
            ],
          },
        },
      ];
    }

    // 6) ctrl+c: interrupt an active turn, else double-press-to-quit
    if (matchesKey(event, "ctrl+c")) {
      if (model.state.turnActive) {
        return [
          model,
          cmd(async () => {
            const r = await client.interrupt();
            return { type: "tui:interrupt", ok: r.ok } as Msg;
          }),
        ];
      }
      const now = Date.now();
      if (now - model.lastCtrlC < 500) {
        return [{ ...model, quitting: true }];
      }
      return [
        {
          ...model,
          lastCtrlC: now,
          state: {
            ...model.state,
            notices: [
              ...model.state.notices,
              notice("press ctrl+c again to quit"),
            ],
          },
        },
      ];
    }

    // 7) ctrl+o: expand/collapse the latest tool call
    if (matchesKey(event, "ctrl+o")) {
      const calls = model.state.toolCalls;
      if (calls.length === 0) return [model];
      let lastIdx = -1;
      for (let i = calls.length - 1; i >= 0; i--) {
        if (calls[i].status === "running" || i === calls.length - 1) {
          lastIdx = i;
          break;
        }
      }
      if (lastIdx < 0) lastIdx = calls.length - 1;
      const toolCalls = calls.map((c, i) =>
        i === lastIdx ? { ...c, expanded: !c.expanded } : c
      );
      return [{ ...model, state: { ...model.state, toolCalls } }];
    }

    // 8) tab: (re-)open the completion menu on a `/partial` token — this also
    //    re-arms an esc-dismissed menu. With no live menu and no candidates,
    //    tab does nothing (keyboard focus never leaves the editor).
    if (event.kind === "key" && event.key === "tab") {
      const text = editorText(model.editor);
      if (
        /^\/\S*$/.test(text) &&
        slashCommandCandidates(text.slice(1), client.commands).length > 0
      ) {
        return [{
          ...model,
          completion: { selected: 0, dismissed: false },
        }];
      }
      return [model];
    }

    // 9) page up/down + mouse wheel scroll the transcript — PgUp/PgDn and the
    //    wheel are viewport controls, not editor input, so they work while the
    //    user is typing.
    if (event.kind === "key") {
      if (event.key === "pageUp") {
        return [applyTranscriptScroll(model, { type: "PageUp" })];
      }
      if (event.key === "pageDown") {
        return [applyTranscriptScroll(model, { type: "PageDown" })];
      }
    }
    if (event.kind === "mouse") {
      if (event.button === MOUSE_BUTTON.wheelUp) {
        return [applyTranscriptScroll(model, { type: "ScrollUp" })];
      }
      if (event.button === MOUSE_BUTTON.wheelDown) {
        return [applyTranscriptScroll(model, { type: "ScrollDown" })];
      }
      // Other mouse events (button presses over the editor, releases) are
      // swallowed — nothing consumes them yet, and they must not fall
      // through to the editor.
      return [model];
    }

    // 10) esc: interrupt an in-flight turn (same as ctrl+c), otherwise snap
    //    the transcript back to the tail. (A live completion menu already
    //    consumed esc at 3) as a plain dismissal.)
    if (event.kind === "esc") {
      if (model.state.turnActive) {
        return [
          model,
          cmd(async () => {
            const r = await client.interrupt();
            return { type: "tui:interrupt", ok: r.ok } as Msg;
          }),
        ];
      }
      return [{
        ...model,
        transcriptScroll: 0,
        followTail: true,
      }];
    }

    // 11) editor: everything else. A buffer change re-arms the completion
    //    menu (clears an esc dismissal and resets the selection) so filtering
    //    follows the typed prefix live.
    const [editorNext, action] = editorReducer(model.editor, event);
    if (action?.type === "submit") {
      return submitText(model, editorNext, action.text);
    }
    const textChanged = editorText(editorNext) !== editorText(model.editor);
    return [{
      ...model,
      editor: editorNext,
      completion: textChanged ? initialCompletionState : model.completion,
    }];
  };

  // -- built-in slash command dispatch --------------------------------------
  // ONE dispatch path feeds both the palette (runPaletteCommand) and editor
  // submit: commands.ts decides whether a text is a built-in, this switch
  // performs the local effect and/or kicks off a Cmd whose CommandOutcome is
  // applied back in `update` (case "tui:command").

  const commandMsg = (outcome: CommandOutcome): Msg =>
    ({ type: "tui:command", outcome }) as Msg;

  /**
   * Derive the live completion menu for the current buffer: active only when
   * the whole buffer is a single slash token (`^/\S*$`) with at least one
   * candidate, no palette/approval is up, and the user has not esc-dismissed
   * the menu for the current token. Returns the candidates plus the clamped
   * selection; null keeps the normal key bindings (history arrows etc.).
   */
  const completionMenu = (
    model: AppModel,
  ): {
    readonly items: readonly CompletionCandidate[];
    readonly selected: number;
  } | null => {
    if (model.approval !== null || model.palette.open) return null;
    if (model.completion.dismissed) return null;
    const text = editorText(model.editor);
    if (!/^\/\S*$/.test(text)) return null;
    const items = slashCommandCandidates(text.slice(1), client.commands);
    if (items.length === 0) return null;
    return {
      items,
      selected: Math.min(model.completion.selected, items.length - 1),
    };
  };

  /**
   * Shared submit pipeline for the editor's enter AND the completion menu's
   * accept-and-submit: built-in slash commands dispatch locally, anything
   * else goes to the server as a prompt. `editorNext` is the post-submit
   * editor state (already cleared by the editor reducer).
   */
  const submitText = (
    model: AppModel,
    editorNext: EditorState,
    text: string,
  ): readonly [AppModel, ...Cmd<Msg>[]] => {
    if (text.trim() === "") return [{ ...model, editor: editorNext }];
    // Built-in slash commands are dispatched locally and never become a
    // prompt; anything else (custom commands, plain text) goes to the
    // server, which expands commands/*.md templates.
    const withEditor: AppModel = {
      ...model,
      editor: editorNext,
      completion: initialCompletionState,
    };
    const builtin = runSlashCommand(withEditor, text);
    if (builtin !== null) return builtin;
    return [
      {
        ...withEditor,
        state: { ...withEditor.state, turnActive: true },
      },
      cmd(async () => {
        const r = await client.prompt(text);
        return {
          type: "tui:prompted",
          ok: r.ok,
          status: r.status,
          body: r.body,
        } as Msg;
      }),
    ];
  };

  /**
   * Completion-menu accept. `submit=false` (tab) fills `/name ` for the user
   * to complete; `submit=true` (enter) submits the command on the spot via
   * the normal pipeline (the editor reducer supplies the history bookkeeping
   * and the cleared buffer).
   */
  const acceptCompletion = (
    model: AppModel,
    menu: { readonly items: readonly CompletionCandidate[]; readonly selected: number },
    submit: boolean,
  ): readonly [AppModel, ...Cmd<Msg>[]] => {
    const item = menu.items[menu.selected];
    if (item === undefined) return [model];
    if (!submit) {
      return [{
        ...model,
        editor: setEditorText(model.editor, `/${item.name} `),
        completion: initialCompletionState,
      }];
    }
    const [editorNext, action] = editorReducer(
      setEditorText(model.editor, `/${item.name}`),
      ENTER_EVENT,
    );
    return action?.type === "submit"
      ? submitText(model, editorNext, action.text)
      : [{ ...model, editor: editorNext, completion: initialCompletionState }];
  };

  const runPaletteCommand = (
    model: AppModel,
    item: PaletteItem,
  ): readonly [AppModel, ...Cmd<Msg>[]] => {
    // Arg-taking built-ins and custom commands seed the editor with `/name `
    // so the user supplies arguments; submitting then re-enters this same
    // dispatch (built-in) or the prompt path (custom, expanded server-side).
    if (!item.builtin || item.takesArg === true) {
      return [{
        ...model,
        editor: setEditorText(model.editor, `${item.name} `),
        completion: initialCompletionState,
      }];
    }
    return runSlashCommand(model, item.name) ?? [model];
  };

  /**
   * Dispatch a `/name args` text against the built-in registry. Returns null
   * when the text is not a built-in command (caller falls through to prompt).
   */
  const runSlashCommand = (
    model: AppModel,
    text: string,
  ): readonly [AppModel, ...Cmd<Msg>[]] | null => {
    const parsed = parseBuiltinCommand(text);
    if (parsed === null) return null;
    switch (parsed.name) {
      case "help": {
        let m = model;
        for (const line of helpLines(client.commands)) m = withNotice(m, line);
        return [m];
      }
      case "exit":
        return [{ ...model, quitting: true }];
      case "model": {
        if (parsed.args === "") {
          return [
            withNotice(model, `model: ${model.state.model ?? "(default)"}`),
          ];
        }
        const ref = parsed.args;
        return [
          model,
          cmd(async () => {
            const r = await client.setModel(ref);
            return commandMsg({ kind: "model", ref, ...r });
          }),
        ];
      }
      case "effort": {
        if (parsed.args === "") {
          return [
            withNotice(model, `effort: ${model.effort ?? "(model default)"}`),
          ];
        }
        const ref = parsed.args;
        return [
          model,
          cmd(async () => {
            const r = await client.setEffort(ref);
            return commandMsg({ kind: "effort", ref, ...r });
          }),
        ];
      }
      case "compact":
        return [
          model,
          cmd(async () => {
            const r = await client.compact();
            return commandMsg({ kind: "compact", ...r });
          }),
        ];
      case "clear":
        return [
          model,
          cmd(async (): Promise<Msg> => {
            try {
              await client.newSession();
              return commandMsg({ kind: "clear", ok: true });
            } catch (err) {
              return commandMsg({
                kind: "clear",
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }),
        ];
      case "resume": {
        if (parsed.args === "") {
          return [
            model,
            cmd(async (): Promise<Msg> => {
              try {
                const sessions = await client.listSessions();
                return commandMsg({ kind: "sessions", ok: true, sessions });
              } catch (err) {
                return commandMsg({
                  kind: "sessions",
                  ok: false,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }),
          ];
        }
        const query = parsed.args;
        return [
          model,
          cmd(async (): Promise<Msg> => {
            try {
              // Resolve exact-or-unique-prefix against the projection rows so
              // a short id prefix is enough; then switch the client over.
              const sessions = await client.listSessions();
              const res = resolveSessionId(
                sessions.map((s) => s.sessionId),
                query,
              );
              if (res.type === "not-found") {
                return commandMsg({
                  kind: "resume",
                  ok: false,
                  error: `session not found: ${query}`,
                });
              }
              if (res.type === "ambiguous") {
                return commandMsg({
                  kind: "resume",
                  ok: false,
                  error: `ambiguous session id ${query}: ${
                    res.matches.join(", ")
                  }`,
                });
              }
              const { info, history } = await client.resume(res.sessionId);
              return commandMsg({ kind: "resume", ok: true, info, history });
            } catch (err) {
              return commandMsg({
                kind: "resume",
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }),
        ];
      }
      case "mcp": {
        const servers = client.mcpServers;
        if (servers.length === 0) {
          return [withNotice(model, "no MCP servers configured")];
        }
        return [
          withNotice(
            model,
            `mcp servers: ${
              servers.map((s) => `${s.id} (${s.toolCount} tools)`).join("  ")
            }`,
          ),
        ];
      }
      default:
        return null;
    }
  };

  /** Apply a finished command's outcome (state + notices) inside update. */
  const applyCommandOutcome = (
    model: AppModel,
    o: CommandOutcome,
  ): readonly [AppModel, ...Cmd<Msg>[]] => {
    switch (o.kind) {
      case "model": {
        if (!o.ok) {
          return [withNotice(model, o.error ?? "model switch failed", "error")];
        }
        const name = o.model ?? o.ref;
        return [{
          ...model,
          state: {
            ...model.state,
            model: name,
            contextWindow: o.contextWindow ?? model.state.contextWindow,
            notices: [...model.state.notices, notice(`model: ${name}`)],
          },
        }];
      }
      case "effort": {
        if (!o.ok) {
          return [
            withNotice(model, o.error ?? "effort switch failed", "error"),
          ];
        }
        const effort = o.effort ?? o.ref;
        return [
          withNotice({ ...model, effort }, `effort: ${effort}`),
        ];
      }
      case "compact": {
        if (o.ok) return [withNotice(model, "compacting context…")];
        if (o.code === "turn_in_flight") {
          return [withNotice(
            model,
            "wait for the current turn to finish before compacting",
          )];
        }
        return [withNotice(model, o.error ?? "compact failed", "error")];
      }
      case "clear": {
        if (!o.ok) {
          return [withNotice(model, o.error ?? "new session failed", "error")];
        }
        // Fresh session: drop every session-scoped slice. The new SSE stream
        // (cursor 0) replays session.created, which repopulates model /
        // contextWindow / mcpServers.
        return [{
          ...model,
          state: {
            ...initialModelState(),
            notices: [notice(`new session ${client.sessionId}`)],
          },
          approval: null,
          effort: undefined,
          transcriptScroll: 0,
          followTail: true,
          completion: initialCompletionState,
        }];
      }
      case "sessions": {
        if (!o.ok || o.sessions === undefined) {
          return [withNotice(model, o.error ?? "session list failed", "error")];
        }
        const lines = formatSessionList(o.sessions);
        const hints = o.sessions.length > 0
          ? [...lines, "use /resume <id> to switch sessions"]
          : lines;
        let m = model;
        for (const line of hints) m = withNotice(m, line);
        return [m];
      }
      case "resume": {
        if (!o.ok || o.info === undefined || o.history === undefined) {
          return [withNotice(model, o.error ?? "resume failed", "error")];
        }
        // Rebuild the session view from the recorded history. RecordedEvent
        // carries seq/ts/sessionId on top of the {type, data} envelope the
        // reducer consumes — strip down to the envelope.
        const events: SseEvent[] = o.history.map((e) => ({
          type: e.type,
          data: e.data as Readonly<Record<string, unknown>>,
        }));
        const rebuilt = reduceEventSequence(events);
        return [{
          ...model,
          state: {
            ...rebuilt,
            model: rebuilt.model ?? o.info.model,
            contextWindow: rebuilt.contextWindow ?? client.contextWindow,
            notices: [
              ...rebuilt.notices,
              notice(`resumed session ${o.info.sessionId}`),
            ],
          },
          approval: null,
          effort: undefined,
          transcriptScroll: 0,
          followTail: true,
          completion: initialCompletionState,
        }];
      }
    }
  };

  // -- update -------------------------------------------------------------

  const update = (
    model: AppModel,
    msg: Msg,
  ): readonly [AppModel, ...Cmd<Msg>[]] => {
    switch (msg.type) {
      case "tuikit:key":
        return handleKey(model, msg.event);

      case "tuikit:resize":
        return [
          { ...model, width: msg.size.cols, height: msg.size.rows },
        ];

      case "tuikit:tick":
        return [{ ...model, spinnerFrame: msg.n }];

      case "tuikit:git-tick":
        return [
          model,
          cmd(async () => {
            const status = await probeGitStatus(deps.workspace);
            // Skip the model write when nothing changed (the probe is mostly
            // stable — avoid re-painting every 2s for nothing).
            const prev = model.gitStatus;
            const same = prev === null && status === null ||
              prev !== null && status !== null &&
                prev.branch === status.branch && prev.dirty === status.dirty;
            return same ? null : ({ type: "tui:git", status } as Msg);
          }),
        ];

      case "tui:git":
        return [{ ...model, gitStatus: msg.status }];

      case "tuikit:error": {
        const message = msg.error instanceof Error
          ? msg.error.message
          : String(msg.error);
        return [
          {
            ...model,
            state: {
              ...model.state,
              notices: [
                ...model.state.notices,
                notice(`error: ${message}`, "error"),
              ],
            },
          },
        ];
      }

      case "tui:sse": {
        const newState = reduceEvent(model.state, msg.event);
        let approval = model.approval;
        // When an approval modal appears, close any open palette so overlay
        // priority and input priority agree (the modal is painted on top AND
        // owns input). A stale, invisible palette underneath the modal would
        // otherwise reappear with its old query once the modal clears.
        let palette = model.palette;
        if (newState.pendingApproval && !model.state.pendingApproval) {
          const p = newState.pendingApproval;
          approval = {
            approvalId: p.approvalId,
            toolName: p.toolName,
            selection: 0,
            preview: makeApprovalPreview(p.input, 80, {
              border: colors.border,
              warning: colors.warning,
              text: colors.text,
              muted: colors.muted,
              accent: colors.accent,
            }),
          };
          if (palette.open) palette = closePalette(palette);
        } else if (!newState.pendingApproval && model.state.pendingApproval) {
          approval = null;
        }
        return [{ ...model, state: newState, approval, palette }];
      }

      case "tui:prompted":
        if (msg.ok) return [model];
        return [
          {
            ...model,
            state: {
              ...model.state,
              notices: [
                ...model.state.notices,
                notice(`prompt rejected (${msg.status}) ${msg.body}`, "error"),
              ],
            },
          },
        ];

      case "tui:approval":
        if (msg.ok) return [model];
        return [
          {
            ...model,
            state: {
              ...model.state,
              notices: [
                ...model.state.notices,
                notice("approval POST failed", "error"),
              ],
            },
          },
        ];

      case "tui:interrupt":
        return [model];

      case "tui:command":
        return applyCommandOutcome(model, msg.outcome);

      case "tui:quit":
        return [{ ...model, quitting: true }];

      default:
        return [model];
    }
  };

  // -- view ---------------------------------------------------------------

  const blankLine = (): StyledLine => ({ spans: [{ text: "", style: {} }] });

  const view = (model: AppModel): readonly StyledLine[] => {
    const W = Math.max(1, model.width);
    const H = Math.max(1, model.height);
    const lines: StyledLine[] = [];
    const layout = computeLayout(model);

    // editor height: 2 borders + up to 5 content rows
    const transcriptH = layout.transcriptH;

    // transcript
    if (transcriptH > 0) {
      let tlines: StyledLine[] = [];
      try {
        tlines = renderTranscript(
          toTranscriptState(model),
          W,
          transcriptH,
          theme,
          {
            spinnerFrame: model.spinnerFrame,
            streaming: model.state.streaming !== null,
          },
        );
      } catch {
        tlines = [];
      }
      for (let i = 0; i < transcriptH; i++) {
        lines.push(tlines[i] ?? blankLine());
      }
    }

    // statusline (1 row)
    try {
      lines.push(renderStatusline(toStatusView(model), W, theme));
    } catch {
      lines.push(blankLine());
    }

    // editor (bottom) — always focused: keyboard focus never leaves it
    const editorLines = renderEditor(
      model.editor,
      W,
      true,
      {
        border: colors.border,
        borderFocused: colors.accent,
        accent: colors.accent,
        text: colors.text,
        placeholder: colors.placeholder,
      },
    );
    for (const l of editorLines) lines.push(l);

    // -- completion menu (popup, NOT dimmed) --------------------------------
    // Stamped left-aligned over the transcript rows directly above the editor
    // box. Never overlaps the editor itself; when the transcript is shorter
    // than the menu, the top rows are clipped.
    const menu = completionMenu(model);
    if (menu !== null) {
      const menuLines = renderCompletionMenu(menu.items, menu.selected, W, {
        border: colors.border,
        accent: colors.accent,
        text: colors.text,
        muted: colors.muted,
      });
      const editorTop = lines.length - editorLines.length;
      const top = Math.max(0, editorTop - menuLines.length);
      for (let i = 0; i < menuLines.length; i++) {
        const row = top + i;
        if (row < editorTop) {
          lines[row] = stampOverlayRow(lines[row], menuLines[i], 0, W);
        }
      }
    }

    // -- overlay compositing (palette / approval) -------------------------
    const overlay = model.approval !== null
      ? {
        ...renderApprovalOverlay(model.approval, W, H, {
          border: colors.border,
          warning: colors.warning,
          text: colors.text,
          muted: colors.muted,
          accent: colors.accent,
        }),
        kind: "box" as const,
      }
      : model.palette.open
      ? {
        ...renderPalette(model.palette, paletteItemList, W, H, {
          border: colors.border,
          accent: colors.accent,
          text: colors.text,
          muted: colors.muted,
          prompt: colors.prompt,
        }),
        kind: "box" as const,
      }
      : null;

    if (overlay !== null) {
      return compositeWithOverlay(lines, overlay, W, H);
    }
    return lines;
  };

  return {
    init: () => [
      initialModel,
      // Probe git state for the very first frame (the slow tick only fires
      // GIT_PROBE_MS in).
      cmd(async () => {
        const status = await probeGitStatus(deps.workspace);
        return { type: "tui:git", status } as Msg;
      }),
    ],
    update,
    view,
    subscriptions: () => [spinnerSub, gitTickSub, sseSub],
    shouldQuit: (model, msg) => model.quitting || msg.type === "tui:quit",
  };
};

// ---------------------------------------------------------------------------
// Git probe (best-effort, never throws — outside a repo / no git binary just
// yields null and the status line hides the slot)
// ---------------------------------------------------------------------------

const runGit = async (
  cwd: string,
  args: readonly string[],
): Promise<string | null> => {
  try {
    const out = await new Deno.Command("git", {
      args: ["-C", cwd, ...args],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!out.success) return null;
    return new TextDecoder().decode(out.stdout).trim();
  } catch {
    return null;
  }
};

/** Probe branch + dirty state for `cwd`. null when not a git work tree. */
export const probeGitStatus = async (
  cwd: string,
): Promise<GitStatus | null> => {
  const branch = await runGit(cwd, ["branch", "--show-current"]);
  if (branch === null) return null;
  // Detached HEAD: --show-current is empty; fall back to the short hash.
  const name = branch.length > 0
    ? branch
    : (await runGit(cwd, ["rev-parse", "--short", "HEAD"])) ?? "";
  if (name.length === 0) return null;
  const dirtyOut = await runGit(cwd, ["status", "--porcelain"]);
  return { branch: name, dirty: (dirtyOut ?? "").length > 0 };
};

// ---------------------------------------------------------------------------
// Helpers used by update / view
// ---------------------------------------------------------------------------

/** Synthetic plain-enter key event — the completion menu's accept-and-submit
 *  replays the editor's own submit path (history bookkeeping + cleared buffer). */
const ENTER_EVENT: import("@niuma/tuikit").InputEvent = {
  kind: "key",
  key: "enter",
  mods: { shift: false, alt: false, ctrl: false, super: false },
  eventType: "press",
};

const approvalDecision = (
  ev: import("@niuma/tuikit").InputEvent,
): { decision: ApprovalDecision; feedback?: string } | null => {
  if (ev.kind === "esc") return { decision: "reject", feedback: "dismissed" };
  if (ev.kind === "text") {
    const ch = ev.text.toLowerCase();
    if (ch === "y") return { decision: "once" };
    if (ch === "a") return { decision: "always" };
    if (ch === "n") return { decision: "reject" };
    // digit shortcuts pick the Nth option directly (1-indexed)
    if (ch >= "1" && ch <= String(APPROVAL_OPTIONS.length)) {
      const idx = ch.charCodeAt(0) - "1".charCodeAt(0);
      return {
        decision: APPROVAL_OPTIONS[idx].decision as ApprovalDecision,
      };
    }
  }
  return null;
};

/** Dim every span of the base scene, then stamp the overlay rows at (top,left). */
const compositeWithOverlay = (
  base: readonly StyledLine[],
  overlay: {
    readonly lines: readonly StyledLine[];
    readonly top: number;
    readonly left: number;
  },
  W: number,
  H: number,
): StyledLine[] => {
  const out: StyledLine[] = [];
  for (let r = 0; r < H; r++) {
    const baseRow = base[r];
    if (r < overlay.top || r >= overlay.top + overlay.lines.length) {
      // dim the base row
      out.push(baseRow ? dimLine(baseRow) : blankLineStatic());
      continue;
    }
    const overlayRow = overlay.lines[r - overlay.top];
    out.push(stampOverlayRow(baseRow, overlayRow, overlay.left, W));
  }
  return out;
};

const dimLine = (line: StyledLine): StyledLine => ({
  spans: line.spans.map((s) => ({
    text: s.text,
    style: { ...s.style, dim: true },
  })),
});

const blankLineStatic = (): StyledLine => ({
  spans: [{ text: "", style: {} }],
});

const stampOverlayRow = (
  base: StyledLine | undefined,
  overlay: StyledLine,
  left: number,
  W: number,
): StyledLine => {
  const spans: StyledSpan[] = [];
  if (left > 0) spans.push({ text: " ".repeat(left), style: {} });
  let used = left;
  for (const s of overlay.spans) {
    spans.push(s);
    used += cellWidth(s.text);
  }
  const pad = W - used;
  if (pad > 0) spans.push({ text: " ".repeat(pad), style: {} });
  else if (base === undefined) {
    // no padding needed
  }
  void base;
  return { spans };
};

// cell width without pulling the native lib at module load (cheap ASCII path;
// wide chars in overlays are rare and only affect trailing padding)
const cellWidth = (s: string): number => {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    w += cp >= 0x1100 && (
        cp <= 0x115f || // Hangul Jamo
        (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || // CJK
        (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
        (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat
        (cp >= 0xfe30 && cp <= 0xfe4f) ||
        (cp >= 0xff00 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6)
      )
      ? 2
      : 1;
  }
  return w;
};
