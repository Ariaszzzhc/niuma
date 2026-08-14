// ===========================================================================
// @niuma/tui — the TEA Program
// ---------------------------------------------------------------------------
// Wires the input components (editor / palette / approval / completion menu)
// and the SSE reducer (`reduce_event.ts`) into one `Program<AppModel, Msg>`
// for `@niuma/tuikit`'s `run`. Owns the full-screen layout (transcript /
// editor / footer), stamps the slash-command completion menu above the editor,
// and coordinates palette + approval input surfaces.
//
// `TuiModelState` remains the event-derived source for each frame. This module
// only derives component view models and input-mode state; it does not keep a
// second transcript tree.
// ===========================================================================

import {
  type Cmd,
  cmd,
  type Color,
  type LoopMsg,
  matchesKey,
  MOUSE_BUTTON,
  type Program,
  screen,
  stringWidth,
  type StyledLine,
  type StyledSpan,
  type Sub,
  tick,
} from "@niuma/tuikit";

// -- Input and interaction components ---------------------------------------
import {
  createEditorState,
  editorIsEmpty,
  editorReducer,
  type EditorState,
  editorText,
  renderEditorSurface,
  setEditorText,
} from "./components/editor.ts";
import {
  APPROVAL_OPTIONS,
  type ApprovalView,
  makeApprovalPreview,
  renderApprovalPanel,
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
  createQuestionState,
  questionReducer,
  type QuestionState,
  renderQuestionPanel,
} from "./components/question.ts";
import {
  initialModelState,
  nextEventId,
  reduceEvent,
  reduceEventSequence,
  type SseEvent,
  type TuiModelState,
  type TuiToolCall,
} from "./reduce_event.ts";
import {
  type AgentStripEntry,
  moveAgentSelection,
  renderAgentStrip,
} from "./components/agent_strip.ts";
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
import {
  decode,
  type RecordedEvent,
  type SessionInfo,
  SseEvent as WireSseEvent,
} from "@niuma/schema";

// -- Transcript and display components --------------------------------------
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
  type FooterView,
  type GitStatus,
  renderFooter,
} from "./components/footer.ts";
import { renderWelcome } from "./components/welcome.ts";

// ---------------------------------------------------------------------------
// Local theme adapters (component-local theme shapes -> product Theme)
// ---------------------------------------------------------------------------

/** Semantic colors the input components need, derived from the product Theme.
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
type ChildHistoryMsg = {
  readonly type: "tui:child-history";
  readonly childSessionId: string;
  readonly events?: ReadonlyArray<RecordedEvent>;
  readonly error?: string;
};
type ChildSseMsg = {
  readonly type: "tui:child-sse";
  readonly childSessionId: string;
  readonly event: SseEvent;
};
type PromptedMsg = {
  readonly type: "tui:prompted";
  readonly ok: boolean;
  readonly status: number;
  readonly disposition?: "started" | "steered" | "queued";
  readonly error?: string;
};
type ApprovalReplyMsg = {
  readonly type: "tui:approval";
  readonly ok: boolean;
  readonly status: number;
  readonly body: string;
};
type InterruptDoneMsg = {
  readonly type: "tui:interrupt";
  readonly ok: boolean;
  readonly status: number;
  readonly returnedInputs: ReadonlyArray<{ readonly sourceText: string }>;
  readonly error?: string;
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
    readonly kind: "rename";
    readonly ok: boolean;
    readonly ref: string;
    readonly title?: string;
    readonly error?: string;
  }
  | {
    readonly kind: "compact";
    readonly ok: boolean;
    readonly code?: string;
    readonly error?: string;
  }
  | {
    readonly kind: "delivery";
    readonly ok: boolean;
    readonly ref: string;
    readonly inputDelivery?: "steer" | "queue";
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
  | ChildHistoryMsg
  | ChildSseMsg
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

/** One open subagent channel: the child's own TuiModelState (fed by its own
 * history fetch + SSE subscription) plus the badge fields shown in the strip. */
interface ChildChannel {
  readonly childSessionId: string;
  /** Short display name from subagent.spawned; the strip label. */
  readonly name: string;
  state: TuiModelState;
  status: "running" | "done" | "failed";
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number | null;
  /** Set when the child's history/stream could not be loaded. */
  streamError: string | null;
}

interface AppModel {
  readonly state: ReturnType<typeof initialModelState>;
  /** Open subagent channels, in spawn order. */
  readonly channels: readonly ChildChannel[];
  /** The channel the transcript currently shows ("main" or a child id). */
  readonly channel: "main" | string;
  /** Agent selector state while the ↓-activated channel list is open. */
  readonly agentSelector: {
    readonly active: boolean;
    readonly selected: number;
  } | null;
  readonly editor: EditorState;
  /** Recovered messages after the one currently visible in the editor.
   * Each remains an independent draft and is surfaced after an explicit
   * submit; nothing in this queue is auto-submitted. */
  readonly draftBacklog: readonly string[];
  /** True while the editor owns the current recovered-draft slot, even if
   * the user edits that draft down to an empty buffer. Only an explicit
   * submit advances the backlog. */
  readonly restoredDraftActive: boolean;
  readonly palette: PaletteState;
  /** Slash-command completion popup state (selection + esc dismissal). */
  readonly completion: CompletionState;
  readonly approval: ApprovalView | null;
  /** Structured question tool surface. Its editor is intentionally separate
   * from `editor`, preserving the user's main draft. */
  readonly question: QuestionState | null;
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
  /** ctrl+o reveals reasoning and tool details for the most recent 3 turns. */
  readonly detailsExpanded: boolean;
  readonly width: number;
  readonly height: number;
}

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

// The app advances `spinnerFrame` on each TickMsg; footer, thinking and tool
// components map that index to the shared Niuma spinner sequence.

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
    channels: [],
    channel: "main",
    agentSelector: null,
    editor: createEditorState(),
    draftBacklog: [],
    restoredDraftActive: false,
    palette: initialPaletteState,
    completion: initialCompletionState,
    approval: null,
    question: null,
    spinnerFrame: 0,
    gitStatus: null,
    transcriptScroll: 0,
    followTail: true,
    quitting: false,
    lastCtrlC: 0,
    effort: undefined,
    detailsExpanded: false,
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

  // Child-stream registry: update() registers a child SSE stream at
  // subagent.spawned and drops it at subagent.completed; sseSub's poll
  // reconciles running child pumps against it (version counter, 100ms cadence
  // — same pattern as the main pump's streamVersion watch).
  const childPumps = new Map<
    string,
    { readonly stream: ReadableStream<Uint8Array> }
  >();
  let pumpsVersion = 0;

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
      const activeChildPumps = new Map<string, () => void>();
      let seenPumpsVersion = -1;

      // One pump body serves the main stream and every child stream: bridge so
      // parseSseStream can lock its own reader while WE keep the real one for
      // cancellation.
      const pumpStream = (
        stream: ReadableStream<Uint8Array>,
        onEvent: (event: SseEvent) => void,
      ): () => void => {
        const reader = stream.getReader();
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
              try {
                const wire = decode(WireSseEvent)({
                  cursor: Number(frame.id),
                  event: JSON.parse(frame.data),
                });
                onEvent(wire.event);
              } catch {
                continue;
              }
            }
          } catch {
            // stream closed / errored — the completion path owns channel UI.
          }
        })();
        return () => {
          cancelled = true;
          void reader.cancel().catch(() => {});
        };
      };

      const startPump = (): void => {
        pumpVersion = client.streamVersion;
        cancelPump = pumpStream(
          client.eventsStream,
          (event) => emit({ type: "tui:sse", event }),
        );
      };

      startPump();
      const poll = setInterval(() => {
        if (disposed) return;
        if (client.streamVersion !== pumpVersion) {
          cancelPump?.();
          startPump();
        }
        // Reconcile child pumps with the registry: start pumps for newly
        // registered streams, cancel the ones update() dropped.
        if (seenPumpsVersion !== pumpsVersion) {
          seenPumpsVersion = pumpsVersion;
          for (const [id, cancel] of activeChildPumps) {
            if (!childPumps.has(id)) {
              cancel();
              activeChildPumps.delete(id);
            }
          }
          for (const [id, entry] of childPumps) {
            if (activeChildPumps.has(id)) continue;
            activeChildPumps.set(
              id,
              pumpStream(
                entry.stream,
                (event) =>
                  emit({ type: "tui:child-sse", childSessionId: id, event }),
              ),
            );
          }
        }
      }, 100);

      return () => {
        disposed = true;
        clearInterval(poll);
        cancelPump?.();
        for (const cancel of activeChildPumps.values()) cancel();
        activeChildPumps.clear();
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

  /** Apply Server-returned unconsumed input to the editor. The confirmed
   * collision rule is intentionally lossy: any existing local editor text
   * wins and ALL returned inputs are discarded. */
  const restoreInputs = (
    model: AppModel,
    inputs: ReadonlyArray<{ readonly sourceText: string }>,
  ): AppModel => {
    if (inputs.length === 0 || !editorIsEmpty(model.editor)) return model;
    const incoming = inputs.map((input) => input.sourceText);
    if (model.restoredDraftActive) {
      return {
        ...model,
        draftBacklog: [...model.draftBacklog, ...incoming],
      };
    }
    const drafts = [...model.draftBacklog, ...incoming];
    const first = drafts[0]!;
    const rest = drafts.slice(1);
    return {
      ...model,
      editor: setEditorText(model.editor, first),
      draftBacklog: rest,
      restoredDraftActive: true,
      completion: initialCompletionState,
    };
  };

  /** After the user explicitly submits one restored draft, reveal the next
   * one without submitting it. */
  const advanceDraftBacklog = (
    model: AppModel,
    editor: EditorState,
  ): Pick<
    AppModel,
    "editor" | "draftBacklog" | "restoredDraftActive"
  > => {
    if (!model.restoredDraftActive || !editorIsEmpty(editor)) {
      return {
        editor,
        draftBacklog: model.draftBacklog,
        restoredDraftActive: model.restoredDraftActive,
      };
    }
    if (model.draftBacklog.length === 0) {
      return {
        editor,
        draftBacklog: [],
        restoredDraftActive: false,
      };
    }
    const [next, ...rest] = model.draftBacklog;
    return {
      editor: setEditorText(editor, next),
      draftBacklog: rest,
      restoredDraftActive: true,
    };
  };

  /** Map the event-derived TuiToolCall into its renderer view model.
   *  `denied` maps to `error`; `durationMs` is omitted while still running. */
  const toToolCallView = (
    c: TuiToolCall,
    expanded: boolean,
  ): ToolCallView => {
    const status: ToolCallView["status"] = c.status === "running"
      ? "running"
      : c.status === "denied" || c.isError
      ? "error"
      : "done";
    const view: ToolCallView = {
      name: c.name,
      status,
      input: c.input,
      inputSummary: stringifyInput(c.input, 120),
      resultLines: c.resultLines,
      expanded,
      activity: c.activity,
      batchId: c.batchId,
    };
    return c.status === "running"
      ? (c.subagent === null ? view : { ...view, subagent: { ...c.subagent } })
      : {
        ...view,
        durationMs: c.durationMs,
        ...(c.subagent === null ? {} : { subagent: { ...c.subagent } }),
      };
  };

  const editorTheme = {
    border: colors.border,
    borderFocused: colors.accent,
    accent: colors.accent,
    text: colors.text,
    placeholder: colors.placeholder,
  } as const;

  const editorMaxRows = (model: AppModel): number => {
    const height = Math.max(1, model.height);
    // The input may grow, but never consume more than roughly a third of a
    // normal terminal. Keep at least one transcript row whenever height allows.
    return Math.max(
      1,
      Math.min(8, Math.floor(height * 0.3), Math.max(1, height - 5)),
    );
  };

  const renderInputSurface = (
    model: AppModel,
  ): {
    readonly lines: readonly StyledLine[];
    readonly cursor?: import("@niuma/tuikit").Cursor;
  } => {
    const width = Math.max(1, model.width);
    const height = Math.max(1, model.height);
    if (model.question !== null) {
      return renderQuestionPanel(
        model.question,
        width,
        {
          border: colors.border,
          accent: colors.accent,
          text: colors.text,
          muted: colors.muted,
          placeholder: colors.placeholder,
        },
        Math.max(1, Math.min(2, height - 7)),
        Math.max(1, Math.min(5, height - 12)),
        Math.max(1, Math.min(3, height - 7)),
      );
    }
    if (model.approval !== null) {
      return renderApprovalPanel(
        model.approval,
        width,
        {
          border: colors.border,
          warning: colors.warning,
          text: colors.text,
          muted: colors.muted,
          accent: colors.accent,
        },
        Math.max(1, Math.min(5, height - 8)),
      );
    }
    if (model.palette.open) {
      return renderPalette(
        model.palette,
        paletteItemList,
        width,
        {
          border: colors.border,
          accent: colors.accent,
          text: colors.text,
          muted: colors.muted,
          prompt: colors.prompt,
        },
        Math.max(1, Math.min(8, height - 7)),
      );
    }
    return renderEditorSurface(
      model.editor,
      width,
      true,
      editorTheme,
      editorMaxRows(model),
    );
  };

  /**
   * Compute the on-screen row budget shared by view and scroll handling.
   * Layout is transcript -> input -> two-line footer. Editor height is based
   * on visual wrapping, not logical newlines.
   */
  const computeLayout = (
    model: AppModel,
  ): { readonly transcriptH: number; readonly inputH: number } => {
    const H = Math.max(1, model.height);
    const inputH = renderInputSurface(model).lines.length;
    const footerH = Math.min(2, Math.max(0, H - inputH));
    // The agent strip occupies one row per channel (plus the main row) above
    // the input surface when subagent channels exist.
    const stripH = model.channels.length > 0 ? model.channels.length + 1 : 0;
    const transcriptH = Math.max(0, H - footerH - inputH - stripH);
    return { transcriptH, inputH };
  };

  /**
   * Build the flat TranscriptState from the event-derived model.
   *
   * `followTail` / `scrollOffset` are the AUTHORITATIVE scroll fields stored on
   * the model (advanced only by `applyTranscriptScroll` / reset on esc+clear).
   * They are passed through verbatim — never re-derived from the offset — so an
   * incoming SSE event while the user is scrolled up cannot re-pin the view.
   *
   * Messages, notices, tool calls, and the live streaming message all receive
   * ids from reduce_event's shared counter. Merging every channel by that id
   * preserves the event chronology while allowing each channel's reducer to
   * update its own entries in place.
   */
  /** The TuiModelState of the channel currently on screen (main or a child). */
  const activeState = (model: AppModel): TuiModelState =>
    model.channel === "main"
      ? model.state
      : model.channels.find((ch) => ch.childSessionId === model.channel)
        ?.state ?? model.state;

  const buildTranscriptMessages = (
    state: TuiModelState,
    model: AppModel,
  ): ChatMessage[] => {
    // The numeric id suffix is a total chronological order across every
    // transcript channel.
    const seqOf = (id: string): number => {
      const n = Number(id.replace(/^[^\d]+/, ""));
      return Number.isFinite(n) ? n : 0;
    };
    const timed: Array<{ seq: number; msg: ChatMessage }> = [
      ...state.messages.map((m) => ({
        seq: seqOf(m.id),
        msg: m.role === "user"
          ? { role: "user", text: m.text } as ChatMessage
          : {
            role: "assistant",
            text: m.text,
            thinking: m.thinking,
          } as ChatMessage,
      })),
      ...state.notices.map((n) => ({
        seq: seqOf(n.id),
        msg: { role: "notice", text: n.text, kind: n.kind } as ChatMessage,
      })),
      ...state.toolCalls.map((c) => ({
        seq: seqOf(c.id),
        msg: {
          role: "tool",
          call: toToolCallView(c, false),
        } as ChatMessage,
      })),
    ];
    const streaming = state.streaming;
    if (
      streaming && (streaming.text.length > 0 || streaming.thinking.length > 0)
    ) {
      timed.push({
        seq: seqOf(streaming.id),
        msg: {
          role: "assistant",
          text: streaming.text,
          thinking: streaming.thinking,
        },
      });
    }
    timed.sort((a, b) => a.seq - b.seq);
    const turnCount = timed.reduce(
      (count, item) => count + (item.msg.role === "user" ? 1 : 0),
      0,
    );
    const recentTurnStart = Math.max(0, turnCount - 2);
    let turn = 0;
    return timed.map((item) => {
      if (item.msg.role === "user") turn++;
      const expanded = model.detailsExpanded && turn >= recentTurnStart;
      if (item.msg.role === "assistant") {
        return { ...item.msg, detailsExpanded: expanded };
      }
      if (item.msg.role === "tool") {
        return {
          ...item.msg,
          call: { ...item.msg.call, expanded },
        };
      }
      return item.msg;
    });
  };

  const toTranscriptState = (model: AppModel): TranscriptState => ({
    messages: buildTranscriptMessages(activeState(model), model),
    scrollOffset: model.transcriptScroll,
    followTail: model.followTail,
  });

  /**
   * The transcript viewport height for the current model. Shared by the scroll
   * handler so its clamp math matches what is actually on screen.
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
      streaming: activeState(model).streaming !== null,
    });
    const viewportHeight = transcriptViewportHeight(model);
    const next = transcriptReducer(ts, msg, { contentLines, viewportHeight });
    return {
      ...model,
      transcriptScroll: next.scrollOffset,
      followTail: next.followTail,
    };
  };

  const toFooterView = (
    model: AppModel,
    hints: readonly string[],
  ): FooterView => ({
    model: model.state.model ?? "",
    effort: model.effort,
    tokensIn: model.state.tokensIn,
    tokensOut: model.state.tokensOut,
    lastInputTokens: model.state.lastInputTokens,
    contextWindow: model.state.contextWindow ?? client.contextWindow,
    cwd: deps.workspace,
    git: model.gitStatus,
    // The MCP list is known the moment the session was created (client) OR
    // when session.created replays over SSE — whichever landed first. null
    // means "handshake still pending" and animates in the footer.
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
    hints,
  });

  // -- key handling -------------------------------------------------------

  const handleKey = (
    model: AppModel,
    event: import("@niuma/tuikit").InputEvent,
  ): readonly [AppModel, ...Cmd<Msg>[]] => {
    // 1) a structured question owns input before every other surface. Its
    //    answer editor is separate from the main draft.
    if (model.question !== null) {
      const question = model.question;
      const [next, action] = questionReducer(question, event);
      if (action === undefined) return [{ ...model, question: next }];
      const decision: ApprovalDecision = action.type === "answer"
        ? "once"
        : "reject";
      return [
        { ...model, question: null },
        cmd(async () => {
          const r = await client.approve(
            question.approvalId,
            decision,
            action.feedback,
          );
          return { type: "tui:approval", ok: r.ok } as Msg;
        }),
      ];
    }

    // 2) approval takes input priority: y/a/n, arrow navigation + enter,
    //    digit shortcuts 1..3 and esc. This comes before the palette so a
    //    request cannot have its decision swallowed by the search query.
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
            return {
              type: "tui:approval",
              ok: r.ok,
              status: r.status,
              body: r.body,
            } as Msg;
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
      return [model]; // swallow everything else while the panel is active
    }

    // Agent selector: while active it owns up/down/enter/esc; every other
    // event is swallowed so the underlying editor buffer stays untouched.
    if (model.agentSelector !== null) {
      const selector = model.agentSelector;
      if (event.kind === "key") {
        if (event.key === "up" || event.key === "down") {
          return [{
            ...model,
            agentSelector: {
              active: true,
              selected: moveAgentSelection(
                selector.selected,
                model.channels.length + 1,
                event.key === "up" ? -1 : 1,
              ),
            },
          }];
        }
        if (event.key === "enter") {
          const target = selector.selected === 0
            ? "main"
            : model.channels[selector.selected - 1]?.childSessionId ?? "main";
          return [{ ...model, channel: target, agentSelector: null }];
        }
      }
      if (event.kind === "esc") return [{ ...model, agentSelector: null }];
      return [model];
    }

    // 3) palette: when OPEN it owns input (the completion menu is derived
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

    // 4) completion menu: auto-pops on a `/partial` token. Navigation keys
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
            return {
              type: "tui:interrupt",
              ok: r.ok,
              status: r.status,
              returnedInputs: r.returnedInputs,
              ...(r.error !== undefined ? { error: r.error } : {}),
            } as Msg;
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

    // 7) ctrl+o: reveal/collapse reasoning and tool detail for the latest
    //    three turns. This is derived view state; the event model stays flat.
    if (matchesKey(event, "ctrl+o")) {
      return [{ ...model, detailsExpanded: !model.detailsExpanded }];
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
            return {
              type: "tui:interrupt",
              ok: r.ok,
              status: r.status,
              returnedInputs: r.returnedInputs,
              ...(r.error !== undefined ? { error: r.error } : {}),
            } as Msg;
          }),
        ];
      }
      return [{
        ...model,
        transcriptScroll: 0,
        followTail: true,
      }];
    }

    // 10.5) agent selector activation: down at the newest editor history
    //       position (historyCursor === null) opens the channel list. Only
    //       when channels exist; single-line buffers only (multi-line down
    //       moves the row cursor).
    if (
      event.kind === "key" && event.key === "down" &&
      model.editor.historyCursor === null &&
      model.editor.lines.length <= 1 &&
      model.channels.length > 0
    ) {
      const currentIndex = model.channel === "main" ? 0 : Math.max(
        0,
        model.channels.findIndex((ch) => ch.childSessionId === model.channel) +
          1,
      );
      return [{
        ...model,
        agentSelector: { active: true, selected: currentIndex },
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
    if (
      model.question !== null ||
      model.approval !== null ||
      model.palette.open
    ) return null;
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
    const advanced = advanceDraftBacklog(model, editorNext);
    if (text.trim() === "") return [{ ...model, ...advanced }];
    // Built-in slash commands are dispatched locally and never become a
    // prompt; anything else (custom commands, plain text) goes to the
    // server, which expands commands/*.md templates.
    const withEditor: AppModel = {
      ...model,
      ...advanced,
      completion: initialCompletionState,
      // A submit always goes to the main session; return the view to it.
      channel: "main",
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
          ...(r.disposition !== undefined
            ? { disposition: r.disposition }
            : {}),
          ...(r.error !== undefined ? { error: r.error } : {}),
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
    menu: {
      readonly items: readonly CompletionCandidate[];
      readonly selected: number;
    },
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
      case "rename": {
        if (parsed.args === "") {
          return [
            withNotice(model, `title: ${model.state.title ?? "(auto)"}`),
          ];
        }
        const ref = parsed.args;
        return [
          model,
          cmd(async () => {
            const r = await client.renameTitle(ref);
            return commandMsg({ kind: "rename", ref, ...r });
          }),
        ];
      }
      case "delivery": {
        if (parsed.args === "") {
          return [withNotice(model, `delivery: ${client.inputDelivery}`)];
        }
        if (parsed.args !== "steer" && parsed.args !== "queue") {
          return [
            withNotice(
              model,
              "delivery must be steer or queue",
              "error",
            ),
          ];
        }
        const ref = parsed.args;
        return [
          model,
          cmd(async () => {
            const r = await client.setInputDelivery(ref);
            return commandMsg({ kind: "delivery", ref, ...r });
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
              // Resolve exact-or-unique-prefix from Journal filenames only;
              // no Session body is opened until the target is known.
              const res = resolveSessionId(
                await client.listSessionIds(),
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
      case "rename": {
        if (!o.ok) {
          return [withNotice(model, o.error ?? "rename failed", "error")];
        }
        const title = o.title ?? o.ref;
        return [
          withNotice({
            ...model,
            state: { ...model.state, title },
          }, `title: ${title}`),
        ];
      }
      case "delivery": {
        if (!o.ok) {
          return [
            withNotice(model, o.error ?? "delivery update failed", "error"),
          ];
        }
        const inputDelivery = o.inputDelivery ?? o.ref;
        return [withNotice(model, `delivery: ${inputDelivery}`)];
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
          question: null,
          channels: [],
          channel: "main",
          agentSelector: null,
          draftBacklog: [],
          restoredDraftActive: false,
          effort: undefined,
          detailsExpanded: false,
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
        // Recorded history already has the same validated event union the
        // reducer consumes.
        const rebuilt = reduceEventSequence(o.history);
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
          question: null,
          channels: [],
          channel: "main",
          agentSelector: null,
          draftBacklog: [],
          restoredDraftActive: false,
          effort: undefined,
          detailsExpanded: false,
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
        let question = model.question;
        // A server interaction surface displaces the palette. Question tool
        // input is structured after call-id correlation; malformed/legacy
        // input safely falls back to the normal approval panel.
        let palette = model.palette;
        if (newState.pendingApproval && !model.state.pendingApproval) {
          const p = newState.pendingApproval;
          const structured = p.toolName === "question"
            ? createQuestionState(p.approvalId, p.input)
            : null;
          if (structured !== null) {
            question = structured;
            approval = null;
          } else {
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
            question = null;
          }
          if (palette.open) palette = closePalette(palette);
        } else if (!newState.pendingApproval && model.state.pendingApproval) {
          approval = null;
          question = null;
        }
        let next: AppModel = {
          ...model,
          state: newState,
          approval,
          question,
          palette,
        };
        // Subagent lifecycle: open a channel at spawn (fetching its history +
        // opening its SSE stream in a Cmd), finalize the badge at completion.
        if (msg.event.type === "subagent.spawned") {
          const d = msg.event.data;
          if (
            !next.channels.some((ch) => ch.childSessionId === d.childSessionId)
          ) {
            next = {
              ...next,
              channels: [...next.channels, {
                childSessionId: d.childSessionId,
                name: d.name,
                state: initialModelState(),
                status: "running",
                tokensIn: null,
                tokensOut: null,
                durationMs: null,
                streamError: null,
              }],
            };
            return [
              next,
              cmd(async () => {
                try {
                  const events = await client.subagentHistory(d.childSessionId);
                  const cursor = events.reduce(
                    (max, e) => Math.max(max, e.seq),
                    0,
                  ) + 1;
                  const stream = await client.openSubagentStream(
                    d.childSessionId,
                    cursor,
                  );
                  childPumps.set(d.childSessionId, { stream });
                  pumpsVersion += 1;
                  return {
                    type: "tui:child-history",
                    childSessionId: d.childSessionId,
                    events,
                  } as Msg;
                } catch (err) {
                  return {
                    type: "tui:child-history",
                    childSessionId: d.childSessionId,
                    error: err instanceof Error ? err.message : String(err),
                  } as Msg;
                }
              }),
            ];
          }
        }
        if (msg.event.type === "subagent.completed") {
          const d = msg.event.data;
          next = {
            ...next,
            channels: next.channels.map((ch) =>
              ch.childSessionId !== d.childSessionId ? ch : {
                ...ch,
                status: d.ok ? "done" as const : "failed" as const,
                durationMs: d.durationMs,
                tokensIn: d.usage?.inputTokens ?? null,
                tokensOut: d.usage?.outputTokens ?? null,
              }
            ),
          };
          childPumps.delete(d.childSessionId);
          pumpsVersion += 1;
          return [next];
        }
        return [
          msg.event.type === "input.recovered"
            ? restoreInputs(next, msg.event.data.inputs)
            : next,
        ];
      }

      case "tui:child-history": {
        const idx = model.channels.findIndex((ch) =>
          ch.childSessionId === msg.childSessionId
        );
        if (idx < 0) return [model];
        const channels = [...model.channels];
        if (msg.error !== undefined) {
          channels[idx] = {
            ...channels[idx],
            streamError: msg.error,
            state: {
              ...channels[idx].state,
              notices: [...channels[idx].state.notices, {
                id: nextEventId("n"),
                kind: "error" as const,
                text: `subagent unavailable: ${msg.error}`,
              }],
            },
          };
        } else {
          channels[idx] = {
            ...channels[idx],
            state: reduceEventSequence(msg.events ?? []),
          };
        }
        return [{ ...model, channels }];
      }

      case "tui:child-sse": {
        const idx = model.channels.findIndex((ch) =>
          ch.childSessionId === msg.childSessionId
        );
        if (idx < 0) return [model];
        const channels = [...model.channels];
        channels[idx] = {
          ...channels[idx],
          state: reduceEvent(channels[idx].state, msg.event),
        };
        return [{ ...model, channels }];
      }

      case "tui:prompted":
        if (msg.ok) {
          if (msg.disposition === "queued") {
            return [withNotice(model, "input queued")];
          }
          if (msg.disposition === "steered") {
            return [withNotice(model, "input steered")];
          }
          return [model];
        }
        return [
          {
            ...model,
            state: {
              ...model.state,
              notices: [
                ...model.state.notices,
                notice(
                  `prompt rejected (${msg.status}) ${msg.error ?? ""}`.trim(),
                  "error",
                ),
              ],
            },
          },
        ];

      case "tui:approval":
        if (msg.ok) return [model];
        return [withNotice(
          model,
          `approval failed (${msg.status}) ${msg.body}`,
          "error",
        )];

      case "tui:interrupt":
        return msg.ok
          ? [restoreInputs(model, msg.returnedInputs)]
          : [withNotice(
            model,
            `interrupt failed (${msg.status}) ${msg.error ?? ""}`.trim(),
            "error",
          )];

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

  const view = (model: AppModel): import("@niuma/tuikit").View => {
    const W = Math.max(1, model.width);
    const H = Math.max(1, model.height);
    const lines: StyledLine[] = [];
    const layout = computeLayout(model);
    const transcriptH = layout.transcriptH;
    const active = activeState(model);
    const hasTranscript = active.messages.length > 0 ||
      active.notices.length > 0 ||
      active.toolCalls.length > 0 ||
      active.streaming !== null;

    // transcript
    if (transcriptH > 0) {
      let tlines: StyledLine[] = [];
      if (!hasTranscript) {
        tlines = renderWelcome(
          {
            version: deps.version,
            workspace: model.state.workspace ?? deps.workspace,
            sessionId: model.state.sessionId ?? client.sessionId,
            model: model.state.model,
            mcpServers: client.mcpServers.length > 0
              ? client.mcpServers
              : model.state.mcpServers,
          },
          W,
          theme,
        );
      } else {
        try {
          tlines = renderTranscript(
            toTranscriptState(model),
            W,
            transcriptH,
            theme,
            {
              spinnerFrame: model.spinnerFrame,
              streaming: active.streaming !== null,
            },
          );
        } catch {
          tlines = [];
        }
      }
      for (let i = 0; i < transcriptH; i++) {
        lines.push(tlines[i] ?? blankLine());
      }
    }

    // -- agent strip (persistent row; expanded selector stamps over the tail) --
    if (model.channels.length > 0) {
      const entries: AgentStripEntry[] = [
        {
          id: "main",
          label: "main",
          status: "main",
          tokensIn: model.state.tokensIn,
          tokensOut: model.state.tokensOut,
          durationMs: null,
        },
        ...model.channels.map((ch) => ({
          id: ch.childSessionId,
          label: ch.name,
          status: ch.status,
          tokensIn: ch.tokensIn,
          tokensOut: ch.tokensOut,
          durationMs: ch.durationMs,
        })),
      ];
      const selectorActive = model.agentSelector?.active ?? false;
      const stripLines = renderAgentStrip(
        entries,
        selectorActive,
        model.agentSelector?.selected ?? 0,
        W,
        {
          text: colors.text,
          muted: colors.muted,
          accent: colors.accent,
          border: colors.border,
        },
      );
      if (!selectorActive) {
        for (const line of stripLines) lines.push(line);
      } else {
        // Overlay the expanded selector on the transcript rows directly above
        // the input surface (same stamp pattern as the completion menu).
        const top = Math.max(0, lines.length - stripLines.length);
        for (let i = 0; i < stripLines.length; i++) {
          if (top + i < lines.length) lines[top + i] = stripLines[i];
        }
      }
    }

    // Exactly one bottom input surface is active at a time. Palette, approval
    // and question preserve the main editor state underneath.
    const inputSurface = renderInputSurface(model);
    const inputTop = lines.length;
    for (const line of inputSurface.lines) lines.push(line);

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
      const top = Math.max(0, inputTop - menuLines.length);
      for (let i = 0; i < menuLines.length; i++) {
        const row = top + i;
        if (row < inputTop) {
          lines[row] = stampPopupRow(menuLines[i], 0, W);
        }
      }
    }

    const footerHints = model.agentSelector !== null
      ? ["↑↓ choose", "enter switch", "esc cancel"]
      : model.question !== null
      ? ["↑↓ choose", "type another answer", "enter send", "esc decline"]
      : model.approval !== null
      ? ["↑↓ choose", "enter confirm", "esc reject"]
      : model.palette.open
      ? ["↑↓ choose", "enter run", "esc close"]
      : menu !== null
      ? ["↑↓ choose", "tab complete", "enter run", "esc close"]
      : [
        "ctrl+p commands",
        model.detailsExpanded ? "ctrl+o collapse" : "ctrl+o details",
        "pgup/pgdn transcript",
      ];
    try {
      const footer = renderFooter(
        toFooterView(model, footerHints),
        W,
        theme,
      );
      for (const line of footer) {
        if (lines.length < H) lines.push(line);
      }
    } catch {
      while (lines.length < H) lines.push(blankLine());
    }

    return screen(
      lines,
      inputSurface.cursor === undefined ? undefined : {
        ...inputSurface.cursor,
        row: inputTop + inputSurface.cursor.row,
      },
    );
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
// yields null and the footer hides the slot)
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

const stampPopupRow = (
  popup: StyledLine,
  left: number,
  W: number,
): StyledLine => {
  const spans: StyledSpan[] = [];
  if (left > 0) spans.push({ text: " ".repeat(left), style: {} });
  let used = left;
  for (const s of popup.spans) {
    spans.push(s);
    used += stringWidth(s.text);
  }
  const pad = W - used;
  if (pad > 0) spans.push({ text: " ".repeat(pad), style: {} });
  return { spans };
};
