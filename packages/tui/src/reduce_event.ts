// ===========================================================================
// @niuma/tui — SSE event -> Model reducer (pure, INPUT/ORCHESTRATION half)
// ---------------------------------------------------------------------------
// `reduceEvent(model, ev)` is the single place that turns a server event
// envelope into model state. It is exhaustively table-driven over every event
// type the server emits (recorded + live), and PURE: no IO, no rendering, no
// imports from the A-side view components. That keeps it unit-testable in
// isolation — `reduce_event_test.ts` feeds canned event sequences and asserts
// on the model without touching the terminal or the native lib.
//
// The model carries the raw conversation data (messages, streaming text, tool
// calls, notices) plus turn/approval state. The A-side `app.ts` view layer
// adapts this model into the shapes `renderTranscript` / `renderToolCall` /
// `renderStatusline` expect (interlock note: `TuiToolCall` / `TuiMessage` are
// the structural source of truth the view reads).
//
// Event envelope shape: `{ type, data }` — exactly what `client.ts` extracts
// from each SSE frame (`payload.type ?? frame.event`, `payload.data ?? {}`),
// matching how `packages/cli/src/run.ts` reads events.
// ===========================================================================

// ---------------------------------------------------------------------------
// Model types
// ---------------------------------------------------------------------------

export type TuiRole = "user" | "assistant";

export interface TuiMessage {
  /** Stable synthetic id (counter-based) for keyed rendering / diffing. */
  readonly id: string;
  readonly role: TuiRole;
  readonly text: string;
  /** Assistant thinking/reasoning (concatenated `thinking` parts), if any. */
  readonly thinking?: string;
}

export type ToolCallStatus = "running" | "done" | "denied";

export interface TuiToolCall {
  readonly callId: string;
  readonly name: string;
  /** Raw tool arguments from the event (arbitrary JSON). */
  readonly input: unknown;
  readonly status: ToolCallStatus;
  /** Latest tool.progress activity line, if any. */
  readonly activity: string | null;
  /** Extracted text lines from the tool result content. */
  readonly resultLines: readonly string[];
  readonly isError: boolean;
  readonly durationMs: number;
  /** ctrl+o expands the latest call in the transcript (toggled by app). */
  readonly expanded: boolean;
}

/** In-flight streaming assistant text (accumulated from text.delta). */
export interface StreamingText {
  readonly id: string;
  readonly text: string;
  /** Accumulated thinking/reasoning (from thinking.delta), shown dimmed. */
  readonly thinking: string;
}

export type NoticeKind = "compaction" | "error" | "abort" | "info";

export interface TuiNotice {
  readonly id: string;
  readonly kind: NoticeKind;
  readonly text: string;
}

/** A pending approval.requested (raw); app.ts builds the rendered overlay. */
export interface PendingApproval {
  readonly approvalId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly input: unknown;
}

export interface TuiModelState {
  readonly sessionId: string | null;
  readonly workspace: string | null;
  readonly model: string | null;
  readonly messages: readonly TuiMessage[];
  readonly streaming: StreamingText | null;
  readonly toolCalls: readonly TuiToolCall[];
  readonly notices: readonly TuiNotice[];
  readonly pendingApproval: PendingApproval | null;
  readonly turnActive: boolean;
  readonly lastStopReason: string | null;
  readonly lastError: string | null;
  readonly compactionCount: number;
}

// ---------------------------------------------------------------------------
// Event envelope type (the shape client.ts delivers)
// ---------------------------------------------------------------------------

export interface SseEvent {
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export const initialModelState = (): TuiModelState => ({
  sessionId: null,
  workspace: null,
  model: null,
  messages: [],
  streaming: null,
  toolCalls: [],
  notices: [],
  pendingApproval: null,
  turnActive: false,
  lastStopReason: null,
  lastError: null,
  compactionCount: 0,
});

// ---------------------------------------------------------------------------
// Id generation (module-local counter; deterministic within a run)
// ---------------------------------------------------------------------------

let idCounter = 0;
const nextId = (prefix: string): string => `${prefix}${++idCounter}`;

/** Reset the id counter (test helper; not for app use). */
export const _resetIds = (): void => {
  idCounter = 0;
};

// ---------------------------------------------------------------------------
// Payload extractors (tolerant of shape drift — events are loosely typed)
// ---------------------------------------------------------------------------

const asString = (v: unknown): string | null =>
  typeof v === "string" ? v : null;

const asNumber = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const asBool = (v: unknown): boolean => v === true;

/** Join the `text` parts of a message `parts` array into one string. */
const joinTextParts = (parts: unknown): string => {
  if (!Array.isArray(parts)) return "";
  const out: string[] = [];
  for (const p of parts) {
    if (
      p !== null && typeof p === "object" &&
      (p as { type?: unknown }).type === "text"
    ) {
      const t = (p as { text?: unknown }).text;
      if (typeof t === "string") out.push(t);
    }
  }
  return out.join("");
};

/**
 * Join the `text` of the `thinking` parts of a message `parts` array. The
 * `encrypted` field on a thinking part is an opaque provider re-submit
 * credential with no display text, so it is skipped — only the human-readable
 * reasoning text is surfaced.
 */
const joinThinkingParts = (parts: unknown): string => {
  if (!Array.isArray(parts)) return "";
  const out: string[] = [];
  for (const p of parts) {
    if (p !== null && typeof p === "object" && (p as { type?: unknown }).type === "thinking") {
      const t = (p as { text?: unknown }).text;
      if (typeof t === "string") out.push(t);
    }
  }
  return out.join("");
};

/** tool.result `content` is `string | Array<{type:"text", text}>`. */
const extractResultLines = (content: unknown): string[] => {
  if (typeof content === "string") return content.split("\n");
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (
      block !== null && typeof block === "object" &&
      (block as { type?: unknown }).type === "text"
    ) {
      const t = (block as { text?: unknown }).text;
      if (typeof t === "string") out.push(...t.split("\n"));
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// Tool-call update helper
// ---------------------------------------------------------------------------

const updateToolCall = (
  model: TuiModelState,
  callId: string,
  fn: (call: TuiToolCall) => TuiToolCall,
): TuiModelState => {
  let found = false;
  const toolCalls = model.toolCalls.map((c) => {
    if (c.callId === callId) {
      found = true;
      return fn(c);
    }
    return c;
  });
  return found ? { ...model, toolCalls } : model;
};

/** Flush any in-flight streaming text as a finalized assistant message. */
const flushStreaming = (model: TuiModelState): TuiModelState => {
  const s = model.streaming;
  if (s === null || (s.text.length === 0 && s.thinking.length === 0)) {
    return { ...model, streaming: null };
  }
  return {
    ...model,
    messages: [
      ...model.messages,
      {
        id: s.id,
        role: "assistant",
        text: s.text,
        thinking: s.thinking.length > 0 ? s.thinking : undefined,
      },
    ],
    streaming: null,
  };
};

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * Pure reducer over a single SSE event. Returns the next model. Unknown event
 * types are a no-op (forward-compatible: new server events never break the
 * TUI, they just render as "nothing changed" until explicitly handled).
 */
export const reduceEvent = (
  model: TuiModelState,
  ev: SseEvent,
): TuiModelState => {
  const d = ev.data;

  switch (ev.type) {
    // -- session lifecycle -------------------------------------------------
    case "session.created":
      return {
        ...model,
        workspace: asString(d["workspace"]) ?? model.workspace,
        model: asString(d["model"]) ?? model.model,
      };

    case "turn.started":
      return { ...model, turnActive: true };

    // -- conversation ------------------------------------------------------
    case "user.message": {
      const text = joinTextParts(d["parts"]);
      return {
        ...model,
        messages: [
          ...model.messages,
          { id: nextId("u"), role: "user", text },
        ],
      };
    }

    case "thinking.delta": {
      const delta = asString(d["delta"]) ?? "";
      if (delta === "") return model;
      const prev = model.streaming;
      return {
        ...model,
        streaming: prev === null
          ? { id: nextId("a"), text: "", thinking: delta }
          : { id: prev.id, text: prev.text, thinking: prev.thinking + delta },
      };
    }

    case "text.delta": {
      const delta = asString(d["delta"]) ?? "";
      if (delta === "") return model;
      const prev = model.streaming;
      return {
        ...model,
        streaming: prev === null
          ? { id: nextId("a"), text: delta, thinking: "" }
          : { id: prev.id, text: prev.text + delta, thinking: prev.thinking },
      };
    }

    case "text.reset":
      // Live signal before a re-sample: drop the partial buffer (text AND
      // thinking — the whole in-flight sample is discarded).
      return { ...model, streaming: null };

    case "assistant.message": {
      const streamingText = model.streaming?.text ?? "";
      const finalizedText = streamingText.length > 0
        ? streamingText
        : joinTextParts(d["parts"]);
      const streamingThinking = model.streaming?.thinking ?? "";
      const thinking = streamingThinking.length > 0
        ? streamingThinking
        : joinThinkingParts(d["parts"]);
      if (finalizedText.length === 0 && thinking.length === 0) {
        return { ...model, streaming: null };
      }
      const id = model.streaming?.id ?? nextId("a");
      return {
        ...model,
        messages: [
          ...model.messages,
          {
            id,
            role: "assistant",
            text: finalizedText,
            thinking: thinking.length > 0 ? thinking : undefined,
          },
        ],
        streaming: null,
      };
    }

    // -- tool calls --------------------------------------------------------
    case "tool.call.requested": {
      const callId = asString(d["callId"]) ?? nextId("c");
      // A repeated request for an already-tracked callId (replay / duplicate
      // live delivery) is a no-op: appending a second entry would double-
      // render the card and, if the original already finished, resurrect it
      // as a fresh "running" call.
      if (model.toolCalls.some((c) => c.callId === callId)) return model;
      const call: TuiToolCall = {
        callId,
        name: asString(d["name"]) ?? "tool",
        input: d["input"],
        status: "running",
        activity: null,
        resultLines: [],
        isError: false,
        durationMs: 0,
        expanded: false,
      };
      return { ...model, toolCalls: [...model.toolCalls, call] };
    }

    case "tool.progress": {
      const callId = asString(d["callId"]);
      if (callId === null) return model;
      const message = asString(d["message"]) ?? null;
      return updateToolCall(model, callId, (c) => ({
        ...c,
        activity: message ?? c.activity,
      }));
    }

    case "tool.result": {
      const callId = asString(d["callId"]);
      if (callId === null) return model;
      return updateToolCall(model, callId, (c) => ({
        ...c,
        status: "done",
        resultLines: extractResultLines(d["content"]),
        isError: asBool(d["isError"]),
        durationMs: asNumber(d["durationMs"]) ?? c.durationMs,
      }));
    }

    case "tool.call.denied": {
      const callId = asString(d["callId"]);
      const reason = asString(d["reason"]);
      if (callId === null) return model;
      return updateToolCall(model, callId, (c) => ({
        ...c,
        status: "denied",
        activity: reason ?? c.activity,
      }));
    }

    case "tool.call.approved":
      // The synthesized rule is server-side; the call proceeds as running.
      return model;

    // -- approvals ---------------------------------------------------------
    case "approval.requested": {
      const approvalId = asString(d["approvalId"]);
      if (approvalId === null) return model;
      return {
        ...model,
        pendingApproval: {
          approvalId,
          callId: asString(d["callId"]) ?? "",
          toolName: asString(d["name"]) ?? "tool",
          input: d["input"],
        },
      };
    }

    case "approval.resolved":
      // decision/feedback are server-side bookkeeping; we just clear the slot.
      return { ...model, pendingApproval: null };

    // -- compaction --------------------------------------------------------
    case "compaction.performed":
      return {
        ...model,
        compactionCount: model.compactionCount + 1,
        notices: [
          ...model.notices,
          { id: nextId("n"), kind: "compaction", text: "context compacted" },
        ],
      };

    // -- errors / turn end -------------------------------------------------
    case "error.occurred": {
      const message = asString(d["message"]) ?? "(no detail)";
      return {
        ...model,
        lastError: message,
        notices: [...model.notices, {
          id: nextId("n"),
          kind: "error",
          text: message,
        }],
      };
    }

    case "turn.completed":
      return {
        ...flushStreaming(model),
        turnActive: false,
        lastStopReason: asString(d["stopReason"]) ?? "stop",
      };

    case "turn.aborted": {
      const reason = asString(d["reason"]) ?? "aborted";
      return {
        ...flushStreaming(model),
        turnActive: false,
        lastStopReason: "abort",
        lastError: reason,
        notices: [...model.notices, {
          id: nextId("n"),
          kind: "abort",
          text: reason,
        }],
      };
    }

    // -- subagent / future events: no-op -----------------------------------
    case "subagent.spawned":
    default:
      return model;
  }
};

/**
 * Fold a sequence of events into a model (convenience for tests and for the
 * app's reconnect/replay path). Starts from `initialModelState()` by default.
 */
export const reduceEventSequence = (
  events: readonly SseEvent[],
  start: TuiModelState = initialModelState(),
): TuiModelState => events.reduce(reduceEvent, start);
