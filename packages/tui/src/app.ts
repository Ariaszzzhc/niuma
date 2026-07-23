// ===========================================================================
// @niuma/tui — the TEA Program (app.ts, INPUT/ORCHESTRATION half)
// ---------------------------------------------------------------------------
// Wires the input components (editor / palette / approval) and the SSE reducer
// (`reduce-event.ts`) into one `Program<AppModel, Msg>` for `@niuma/tuikit`'s
// `run`. Owns the full-screen layout (transcript / statusline / editor) and
// overlays the palette + approval modal on a dimmed base scene.
//
// INTERLOCK (A-side, owned by a parallel agent — imported, not stubbed):
//   - renderTranscript(state: TranscriptState, w, h, theme)       [transcript.ts]
//   - renderToolCall(call: ToolCallView, w, theme)                [tool-call.ts]
//   - renderStatusline(view: StatusView, w, theme)                [statusline.ts]
//   - Theme / pickTheme / detectTerminalBg                        [theme.ts]
// This file ADAPTS this package's data model (`TuiModelState` from
// reduce-event.ts) into the view-models those renderers expect. The exact
// field shapes of `TranscriptState` / `ToolCallView` / `StatusView` are the
// reconciliation surface; `app.ts` therefore type-checks only once the A-side
// modules land with matching shapes (expected mid-run friction).
// ===========================================================================

import {
  type Cmd,
  type Color,
  type KeyMsg,
  type LoopMsg,
  type Program,
  type ResizeMsg,
  type StyledLine,
  type StyledSpan,
  type Sub,
  type TickMsg,
  cmd,
  matchesKey,
  tick,
} from "@niuma/tuikit";

// -- B-side (this package) ---------------------------------------------------
import {
  type EditorState,
  createEditorState,
  editorReducer,
  renderEditor,
} from "./components/editor.ts";
import {
  type ApprovalView,
  makeApprovalPreview,
  renderApprovalOverlay,
  stringifyInput,
} from "./components/approval.ts";
import {
  type PaletteState,
  closePalette,
  initialPaletteState,
  paletteReducer,
  renderPalette,
} from "./components/palette.ts";
import {
  type SseEvent,
  type TuiToolCall,
  initialModelState,
  reduceEvent,
} from "./reduce-event.ts";
import { type ApprovalDecision, type TuiClient, parseSseStream } from "./client.ts";

// -- A-side view layer (parallel agent) --------------------------------------
// Imported by signature; shapes reconciled against the landed modules.
import { type Theme } from "./theme.ts";
import {
  type ChatMessage,
  type TranscriptMsg,
  type TranscriptState,
  renderTranscript,
  transcriptContentHeight,
  transcriptReducer,
} from "./components/transcript.ts";
import { type ToolCallView } from "./components/tool-call.ts";
import { type StatusView, renderStatusline } from "./components/statusline.ts";

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
type InterruptDoneMsg = { readonly type: "tui:interrupt"; readonly ok: boolean };
type QuitMsg = { readonly type: "tui:quit" };

type Msg =
  | LoopMsg
  | SseMsg
  | PromptedMsg
  | ApprovalReplyMsg
  | InterruptDoneMsg
  | QuitMsg;

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

type Focus = "editor" | "transcript";

interface AppModel {
  readonly state: ReturnType<typeof initialModelState>;
  readonly editor: EditorState;
  readonly palette: PaletteState;
  readonly approval: ApprovalView | null;
  readonly spinnerFrame: number;
  /** Scroll offset (rendered lines from the top). Authoritative only while
   * `followTail` is false; ignored (pinned to bottom) while following. */
  readonly transcriptScroll: number;
  /** When true the transcript stays glued to the newest content. Any scroll up
   * breaks follow; scrolling back to the exact bottom re-engages it. This is
   * the authoritative flag (not re-derived from the offset) so an incoming SSE
   * event never re-pins a view the user scrolled up. */
  readonly followTail: boolean;
  readonly focus: Focus;
  readonly quitting: boolean;
  readonly lastCtrlC: number;
  readonly width: number;
  readonly height: number;
}

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

// The app advances `spinnerFrame` on each TickMsg; the A-side statusline and
// tool-call components map that index to a braille glyph themselves, so no
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
  const { client, theme, version, workspace } = deps;
  const colors = themeColors(theme);

  const initialModel: AppModel = {
    state: initialModelState(),
    editor: createEditorState(),
    palette: initialPaletteState,
    approval: null,
    spinnerFrame: 0,
    transcriptScroll: 0,
    followTail: true,
    focus: "editor",
    quitting: false,
    lastCtrlC: 0,
    width: deps.size.cols,
    height: deps.size.rows,
  };

  // -- subscriptions: spinner tick + SSE pump -----------------------------
  const spinnerSub: Sub<Msg> = tick(80, (n) => ({
    type: "tuikit:tick",
    n,
  }) as Msg);

  const sseSub: Sub<Msg> = {
    subscribe: (emit) => {
      let cancelled = false;
      (async () => {
        try {
          for await (const frame of parseSseStream(client.eventsStream)) {
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
      return () => {
        cancelled = true;
      };
    },
  };

  // -- helpers ------------------------------------------------------------

  const notice = (text: string, kind: "info" | "error" = "info") => ({
    id: `n${Date.now()}${Math.random()}`,
    kind,
    text,
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
    return c.status === "running" ? view : { ...view, durationMs: c.durationMs };
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
    const editorContentRows = Math.min(5, Math.max(1, model.editor.lines.length));
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
   * INTERLEAVING NOTE: reduce-event keeps user/assistant text and tool calls
   * in separate arrays, so here we append tool calls after the text messages
   * and the live streaming text last. Perfect message/tool interleaving would
   * need a single ordered timeline in reduce-event (future refinement).
   */
  const buildTranscriptMessages = (model: AppModel): ChatMessage[] => {
    const baseMsgs: ChatMessage[] = model.state.messages.map((m) =>
      m.role === "user"
        ? { role: "user", text: m.text }
        : { role: "assistant", text: m.text }
    );
    const toolMsgs: ChatMessage[] = model.state.toolCalls.map(
      (c): ChatMessage => ({ role: "tool", call: toToolCallView(c) }),
    );
    let messages: ChatMessage[] = [...baseMsgs, ...toolMsgs];
    if (model.state.streaming && model.state.streaming.text.length > 0) {
      messages = [
        ...messages,
        { role: "assistant", text: model.state.streaming.text },
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
    return { ...model, transcriptScroll: next.scrollOffset, followTail: next.followTail };
  };

  const toStatusView = (model: AppModel): StatusView => ({
    model: model.state.model ?? "",
    tokensIn: 0,
    tokensOut: 0,
    activity: model.state.turnActive
      ? (model.state.streaming !== null ? "generating" : "working")
      : null,
    spinnerFrame: model.spinnerFrame,
  });

  // -- key handling -------------------------------------------------------

  const handleKey = (model: AppModel, event: import("@niuma/tuikit").InputEvent): readonly [AppModel, ...Cmd<Msg>[]] => {
    // 1) approval modal takes INPUT priority (it is also painted on top in the
    //    view): it captures y / a / n / esc and swallows everything else while
    //    up. This MUST come before the palette so an approval arriving while
    //    the palette is open cannot have its y/a/n swallowed by the palette
    //    query (overlay priority and input priority then agree).
    if (model.approval !== null) {
      const decision = approvalDecision(event);
      if (decision !== null) {
        const approvalId = model.approval.approvalId;
        const cleared: AppModel = { ...model, approval: null };
        return [
          cleared,
          cmd(async () => {
            const r = await client.approve(approvalId, decision.decision, decision.feedback);
            return { type: "tui:approval", ok: r.ok } as Msg;
          }),
        ];
      }
      return [model]; // swallow everything else while the modal is up
    }

    // 2) palette gets the next crack (opens on ctrl+p, owns input when open)
    const [paletteNext, paletteAction] = paletteReducer(model.palette, event);
    if (paletteNext.open || paletteAction !== undefined) {
      let m: AppModel = { ...model, palette: paletteNext };
      if (paletteAction?.type === "execute") {
        m = runPaletteCommand(m, paletteAction.command);
      }
      return [m];
    }

    // 3) ctrl+c: interrupt an active turn, else double-press-to-quit
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
            notices: [...model.state.notices, notice("press ctrl+c again to quit")],
          },
        },
      ];
    }

    // 4) ctrl+o: expand/collapse the latest tool call
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

    // 5) tab: toggle focus editor <-> transcript
    if (event.kind === "key" && event.key === "tab") {
      return [{ ...model, focus: model.focus === "editor" ? "transcript" : "editor" }];
    }

    // 6) scroll keys when the transcript is focused — routed through the pure
    //    transcriptReducer (given the live content + viewport height) so offsets
    //    clamp and scrolling back to the bottom re-engages followTail. home/end
    //    jump to the absolute top / bottom.
    if (model.focus === "transcript" && event.kind === "key") {
      if (event.key === "home") {
        return [{ ...model, transcriptScroll: 0, followTail: false }];
      }
      if (event.key === "end") {
        return [{ ...model, followTail: true }];
      }
      const smsg = scrollMsg(event.key);
      if (smsg !== null) {
        return [applyTranscriptScroll(model, smsg)];
      }
    }

    // 7) esc: cancel an in-flight scroll / refocus editor
    if (event.kind === "esc") {
      return [{ ...model, focus: "editor", transcriptScroll: 0, followTail: true }];
    }

    // 8) editor: everything else
    const [editorNext, action] = editorReducer(model.editor, event);
    if (action?.type === "submit") {
      const text = action.text;
      if (text.trim() === "") return [{ ...model, editor: editorNext }];
      return [
        {
          ...model,
          editor: editorNext,
          state: { ...model.state, turnActive: true },
          focus: "editor",
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
    }
    return [{ ...model, editor: editorNext }];
  };

  const runPaletteCommand = (
    model: AppModel,
    command: string,
  ): AppModel => {
    switch (command) {
      case "/quit":
        return { ...model, quitting: true };
      case "/clear":
        return {
          ...model,
          state: {
            ...model.state,
            messages: [],
            notices: [],
            streaming: null,
            toolCalls: [],
          },
          transcriptScroll: 0,
          followTail: true,
        };
      case "/help":
        return {
          ...model,
          state: {
            ...model.state,
            notices: [
              ...model.state.notices,
              notice(
                "enter submit · shift+enter newline · ctrl+p palette · ctrl+o expand · ctrl+c interrupt/quit · tab focus",
              ),
            ],
          },
        };
      case "/model":
        return {
          ...model,
          state: {
            ...model.state,
            notices: [
              ...model.state.notices,
              notice(`model: ${model.state.model ?? "(default)"}`),
            ],
          },
        };
      default:
        return model;
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

      case "tuikit:error": {
        const message = msg.error instanceof Error ? msg.error.message : String(msg.error);
        return [
          {
            ...model,
            state: {
              ...model.state,
              notices: [...model.state.notices, notice(`error: ${message}`, "error")],
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
        // restore editor focus when a turn ends
        const focus: Focus = (!newState.turnActive && model.state.turnActive)
          ? "editor"
          : model.focus;
        return [{ ...model, state: newState, approval, palette, focus }];
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
              notices: [...model.state.notices, notice("approval POST failed", "error")],
            },
          },
        ];

      case "tui:interrupt":
        return [model];

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
    const editorH = layout.editorH;
    const statusH = 1;
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
      for (let i = 0; i < transcriptH; i++) lines.push(tlines[i] ?? blankLine());
    }

    // statusline (1 row)
    try {
      lines.push(renderStatusline(toStatusView(model), W, theme));
    } catch {
      lines.push(blankLine());
    }

    // editor (bottom)
    const editorLines = renderEditor(model.editor, W, model.focus === "editor", {
      border: colors.border,
      accent: colors.accent,
      text: colors.text,
      placeholder: colors.placeholder,
    });
    for (const l of editorLines) lines.push(l);

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
      ? { ...renderPalette(model.palette, W, H, {
          border: colors.border,
          accent: colors.accent,
          text: colors.text,
          muted: colors.muted,
          prompt: colors.prompt,
        }), kind: "box" as const }
      : null;

    if (overlay !== null) {
      return compositeWithOverlay(lines, overlay, W, H);
    }
    return lines;
  };

  return {
    init: () => [initialModel],
    update,
    view,
    subscriptions: () => [spinnerSub, sseSub],
    shouldQuit: (model, msg) => model.quitting || msg.type === "tui:quit",
  };
};

// ---------------------------------------------------------------------------
// Helpers used by update / view
// ---------------------------------------------------------------------------

const approvalDecision = (
  ev: import("@niuma/tuikit").InputEvent,
): { decision: ApprovalDecision; feedback?: string } | null => {
  if (ev.kind === "esc") return { decision: "reject", feedback: "dismissed" };
  if (ev.kind === "text") {
    const ch = ev.text.toLowerCase();
    if (ch === "y") return { decision: "once" };
    if (ch === "a") return { decision: "always" };
    if (ch === "n") return { decision: "reject" };
  }
  return null;
};

/** Map a named key to a transcript scroll reducer message (home/end are handled
 *  inline by the caller as absolute jumps). Returns null for non-scroll keys. */
const scrollMsg = (key: import("@niuma/tuikit").NamedKey): TranscriptMsg | null => {
  switch (key) {
    case "up":
      return { type: "ScrollUp" };
    case "down":
      return { type: "ScrollDown" };
    case "pageUp":
      return { type: "PageUp" };
    case "pageDown":
      return { type: "PageDown" };
    default:
      return null;
  }
};

/** Dim every span of the base scene, then stamp the overlay rows at (top,left). */
const compositeWithOverlay = (
  base: readonly StyledLine[],
  overlay: { readonly lines: readonly StyledLine[]; readonly top: number; readonly left: number },
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

const blankLineStatic = (): StyledLine => ({ spans: [{ text: "", style: {} }] });

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
    ) ? 2 : 1;
  }
  return w;
};
