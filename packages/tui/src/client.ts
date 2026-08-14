// ===========================================================================
// @niuma/tui — live session client (INPUT/ORCHESTRATION half)
// ---------------------------------------------------------------------------
// `TuiClient` is the TUI's thin HTTP client over the tunnelled server, and it
// doubles as the session manager behind the /clear and /resume builtins. It
// mirrors the one-shot ordering in `packages/cli/src/run.ts`:
//
//   1. POST /sessions                -> { sessionId, contextWindow, ... }
//   2. GET  /events?session=<id>&cursor=0   (opened BEFORE the first prompt
//      so an early approval.requested or text.delta is never missed)
//   3. (later) POST /sessions/:id/prompt    per submitted editor text
//   4. POST /sessions/:id/approvals/:aid    on a y/a/n decision
//   5. POST /sessions/:id/interrupt          on ctrl+c while streaming
//   6. POST /sessions/:id/model | /effort | /compact   from the /model,
//      /effort and /compact built-in commands (failures arrive in the
//      {error:{code,message}} shape; /compact answers turn_in_flight while a
//      turn is active)
//
// Session switching:
//
//   - `newSession()` repeats steps 1-2 (fresh session, cursor 0).
//   - `listSessions()` is `GET /sessions` (recent folded Session State).
//   - `listSessionIds()` reads filenames only for prefix resolution.
//   - `resume(id)` is `GET /sessions/:id` -> { info, history }, then re-opens
//     the SSE stream at `max(history.seq) + 1` so the live tail never
//     re-delivers an event already present in the returned history (the
//     server's replay emits `seq >= cursor`; see packages/server/src/
//     session_store.ts).
//
// SSE SWITCH CONTRACT (consumed by app.ts's sseSub):
// `eventsStream` and `streamVersion` are getters over mutable current-session
// state. `streamVersion` starts at 0 and increments on every successful
// `newSession()` / `resume()`. A consumer must poll `streamVersion`; when it
// changes, cancel the pump reading the old stream and start a fresh pump over
// the NEW `client.eventsStream`. The client does NOT cancel the old stream
// itself — the pump owns the reader lock, and tearing down the pump releases
// the connection. All state accessors (sessionId / contextWindow /
// mcpServers / commands / eventsStream) always reflect the CURRENT session;
// prompt / approve / interrupt target the current session.
//
// The app owns the SSE consumption loop (a Sub that drives `reduceEvent`);
// `parseSseStream` is re-exported here so the app imports both from one
// place. The parser lives with the shared wire protocol in @niuma/schema.
// ===========================================================================

import {
  CreateSessionRes,
  decode,
  GetSessionRes,
  type InputDelivery,
  InterruptRes as InterruptResponse,
  PromptRes as PromptResponse,
  type RecordedEvent,
  SessionIdListRes,
  type SessionInfo,
  SessionListRes,
  SetEffortRes as SetEffortResponse,
  SetInputDeliveryRes as SetInputDeliveryResponse,
  SetModelRes as SetModelResponse,
  SetTitleRes as SetTitleResponse,
} from "@niuma/schema";

export { parseSseStream, type SseFrame } from "@niuma/schema";

// Fake host used by the tunnel — Hono routes on the path; the host is
// arbitrary. Re-using the same constant the one-shot runner uses keeps the
// two clients consistent.
const BASE = "http://niuma.internal";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApprovalDecision = "once" | "always" | "reject";

/** A custom slash command the server listed for this session's workspace
 * (commands/*.md templates; expansion happens server-side on prompt). */
export interface ClientCommand {
  readonly name: string;
  readonly description?: string;
  readonly argumentHint?: string;
}

export interface ClientResult {
  readonly ok: boolean;
  readonly status: number;
  readonly body: string;
}

export interface PromptResult {
  readonly ok: boolean;
  readonly status: number;
  readonly disposition?: "started" | "steered" | "queued";
  readonly code?: string;
  readonly error?: string;
}

export interface InterruptResult {
  readonly ok: boolean;
  readonly status: number;
  readonly returnedInputs: ReadonlyArray<{ readonly sourceText: string }>;
  readonly code?: string;
  readonly error?: string;
}

export interface SetInputDeliveryResult {
  readonly ok: boolean;
  readonly inputDelivery?: InputDelivery;
  readonly code?: string;
  readonly error?: string;
}

/** Parsed outcome of POST /sessions/:id/model. On success carries the
 * resolved model name and context window when the server reported them; on
 * failure the {error:{code,message}} fields. Never throws. */
export interface SetModelResult {
  readonly ok: boolean;
  readonly model?: string;
  readonly contextWindow?: number;
  readonly code?: string;
  readonly error?: string;
}

/** Parsed outcome of POST /sessions/:id/effort (same contract as SetModelResult). */
export interface SetEffortResult {
  readonly ok: boolean;
  readonly effort?: string;
  readonly code?: string;
  readonly error?: string;
}

/** Parsed outcome of POST /sessions/:id/title (same contract as SetEffortResult). */
export interface SetTitleResult {
  readonly ok: boolean;
  readonly title?: string;
  readonly code?: string;
  readonly error?: string;
}

/** Parsed outcome of POST /sessions/:id/compact. `code === "turn_in_flight"`
 * means the server rejected the request because a turn is active. */
export interface CompactResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly error?: string;
}

export interface TuiClientOptions {
  readonly workspace: string;
  /** Bare model id recorded on the session; omit for the mock provider. */
  readonly model?: string;
  /** Existing Session Journal to open instead of creating a fresh Session. */
  readonly resume?: string;
}

/** The payload `resume()` hands back: folded Session State plus its
 * recorded history events (already reflected in the log — do NOT expect them
 * on the new SSE stream, which starts strictly after them). */
export interface ResumeResult {
  readonly info: SessionInfo;
  readonly history: ReadonlyArray<RecordedEvent>;
}

export interface TuiClient {
  /** The session the client is CURRENTLY bound to (changes on
   * newSession/resume). */
  readonly sessionId: string;
  /** Resolved context window for the current session's model, when the server
   * knows it (drives the footer's context-usage percentage). */
  readonly contextWindow: number | null;
  /** MCP servers the server connected at boot (id + contributed tool count).
   * Empty when none are configured. */
  readonly mcpServers: ReadonlyArray<{ id: string; toolCount: number }>;
  /** Custom slash commands visible to the current session (user + project
   * commands/*.md). Empty when none are defined. */
  readonly commands: ReadonlyArray<ClientCommand>;
  /** Server-owned prompt admission mode currently in force. */
  readonly inputDelivery: InputDelivery;
  /** The CURRENT open SSE `/events` body; the app consumes it via
   * `parseSseStream`. Replaced on session switch — pair with
   * `streamVersion`. */
  readonly eventsStream: ReadableStream<Uint8Array>;
  /** Monotonically increasing stream generation: starts at 0, +1 per
   * successful newSession/resume. Consumers poll this to know when to drop
   * the old pump and re-read `eventsStream` (see the banner contract). */
  readonly streamVersion: number;
  /** Submit a prompt to the current session (kicks off an agent turn). */
  readonly prompt: (text: string) => Promise<PromptResult>;
  /** Resolve a pending approval of the current session. */
  readonly approve: (
    approvalId: string,
    decision: ApprovalDecision,
    feedback?: string,
  ) => Promise<ClientResult>;
  /** Interrupt the current session's in-flight turn (ctrl+c). */
  readonly interrupt: () => Promise<InterruptResult>;
  /** Create a fresh session and switch to it (SSE re-opened at cursor 0,
   * `streamVersion` bumped). Rejects on a server/stream failure. */
  readonly newSession: () => Promise<void>;
  /** List the most recently touched Sessions for the /resume picker. */
  readonly listSessions: () => Promise<ReadonlyArray<SessionInfo>>;
  /** List Session ids from Journal filenames without folding every Journal. */
  readonly listSessionIds: () => Promise<ReadonlyArray<string>>;
  /** Switch to an existing session: fetches its info + full recorded history,
   * re-opens the SSE stream after the last recorded seq, and bumps
   * `streamVersion`. Rejects when the session is unknown or the stream fails
   * to open. */
  readonly resume: (sessionId: string) => Promise<ResumeResult>;
  /** Switch the current session's model (`provider/model-id` or a bare id).
   * On success the client's `contextWindow` getter reflects the server's
   * resolved window. */
  readonly setModel: (model: string) => Promise<SetModelResult>;
  /** Set the current session's thinking effort (provider-defined string,
   * passed through verbatim). */
  readonly setEffort: (effort: string) => Promise<SetEffortResult>;
  /** Set the current session's custom title (/rename). The server trims;
   * the returned title is authoritative. */
  readonly renameTitle: (title: string) => Promise<SetTitleResult>;
  /** Request an explicit Server config update. The returned value is the
   * authoritative mode after persistence succeeds. */
  readonly setInputDelivery: (
    inputDelivery: InputDelivery,
  ) => Promise<SetInputDeliveryResult>;
  /** Ask the server to compact the current session's context. Rejected with
   * `code: "turn_in_flight"` while a turn is active. */
  readonly compact: () => Promise<CompactResult>;
  /** Read a subagent session's recorded history. Read-only: never switches
   * or otherwise touches the current session. */
  readonly subagentHistory: (
    sessionId: string,
  ) => Promise<ReadonlyArray<RecordedEvent>>;
  /** Open the SSE /events stream for a subagent session at `cursor`. Does
   * NOT touch current-session state. */
  readonly openSubagentStream: (
    sessionId: string,
    cursor: number,
  ) => Promise<ReadableStream<Uint8Array>>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const safeText = async (res: Response): Promise<string> => {
  try {
    return await res.text();
  } catch {
    return "";
  }
};

const jsonHeaders = { "content-type": "application/json" };

const enc = encodeURIComponent;

const tryParseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** Extract {code, message} from the {error:{code,message}} failure shape. */
const errorFields = (
  text: string,
): { readonly code?: string; readonly message?: string } => {
  const body = tryParseJson(text) as
    | { error?: { code?: unknown; message?: unknown } }
    | undefined;
  const code = typeof body?.error?.code === "string"
    ? body.error.code
    : undefined;
  const message = typeof body?.error?.message === "string"
    ? body.error.message
    : undefined;
  return {
    ...(code !== undefined ? { code } : {}),
    ...(message !== undefined ? { message } : {}),
  };
};

/** Current-session state the accessors below read. */
interface SessionState {
  sessionId: string;
  contextWindow: number | null;
  mcpServers: ReadonlyArray<{ id: string; toolCount: number }>;
  commands: ReadonlyArray<ClientCommand>;
  inputDelivery: InputDelivery;
  eventsStream: ReadableStream<Uint8Array>;
  streamVersion: number;
}

/** POST /sessions and parse the create response into SessionState fields. */
const createSessionOnServer = async (
  fetchImpl: typeof fetch,
  opts: TuiClientOptions,
): Promise<
  Pick<
    SessionState,
    | "sessionId"
    | "contextWindow"
    | "mcpServers"
    | "commands"
    | "inputDelivery"
  >
> => {
  const createBody: Record<string, unknown> = {};
  if (opts.model !== undefined) createBody.model = opts.model;
  try {
    const res = await fetchImpl(`${BASE}/sessions`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify(createBody),
    });
    if (!res.ok) {
      throw new Error(
        `session create failed (${res.status}) ${await safeText(res)}`,
      );
    }
    const created = decode(CreateSessionRes)(await res.json());
    const contextWindow = typeof created.contextWindow === "number" &&
        Number.isFinite(created.contextWindow) && created.contextWindow > 0
      ? created.contextWindow
      : null;
    return {
      sessionId: created.sessionId,
      contextWindow,
      mcpServers: created.mcpServers,
      commands: created.commands,
      inputDelivery: created.clientConfig.inputDelivery,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`niuma: session create error: ${msg}`);
  }
};

/** Open the SSE `/events` stream for a session at `cursor` (server replays
 * events with `seq >= cursor`, then live-tails). */
const openEventStream = async (
  fetchImpl: typeof fetch,
  sessionId: string,
  cursor: number,
): Promise<ReadableStream<Uint8Array>> => {
  const eventsUrl = `${BASE}/events?session=${enc(sessionId)}&cursor=${cursor}`;
  let sseRes: Response;
  try {
    sseRes = await fetchImpl(eventsUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`niuma: events stream error: ${msg}`);
  }
  if (!sseRes.ok || !sseRes.body) {
    throw new Error(
      `niuma: events stream failed (${sseRes.status}) ${await safeText(sseRes)}`,
    );
  }
  return sseRes.body;
};

const getSessionOnServer = async (
  fetchImpl: typeof fetch,
  sessionId: string,
) => {
  const res = await fetchImpl(`${BASE}/sessions/${enc(sessionId)}`);
  if (!res.ok) {
    throw new Error(
      `niuma: session resume failed (${res.status}) ${await safeText(res)}`,
    );
  }
  return decode(GetSessionRes)(await res.json());
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create or explicitly resume the first Session and open its SSE stream, then
 * return a session
 * manager bound to that session. Resolves once both have succeeded (the
 * stream is open but NOT yet consumed — the app starts a Sub for that).
 * Rejects on a session-create or stream-open failure so `runTui` can surface
 * a non-zero exit code.
 */
export const createTuiClient = async (
  fetchImpl: typeof fetch,
  opts: TuiClientOptions,
): Promise<TuiClient> => {
  // 1. A default boot creates a Session without scanning the Session
  // directory. An explicit --resume reads exactly the requested Journal.
  let created: Pick<
    SessionState,
    | "sessionId"
    | "contextWindow"
    | "mcpServers"
    | "commands"
    | "inputDelivery"
  >;
  if (opts.resume === undefined) {
    created = await createSessionOnServer(fetchImpl, opts);
  } else {
    const payload = await getSessionOnServer(fetchImpl, opts.resume);
    let contextWindow = payload.contextWindow ?? null;
    if (opts.model !== undefined) {
      const res = await fetchImpl(
        `${BASE}/sessions/${enc(opts.resume)}/model`,
        {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ model: opts.model }),
        },
      );
      if (!res.ok) {
        throw new Error(
          `niuma: resumed session model update failed (${res.status}) ${await safeText(
            res,
          )}`,
        );
      }
      const model = decode(SetModelResponse)(await res.json());
      contextWindow = model.contextWindow ?? contextWindow;
    }
    created = {
      sessionId: payload.info.sessionId,
      contextWindow,
      mcpServers: payload.mcpServers,
      commands: payload.commands,
      inputDelivery: payload.clientConfig.inputDelivery,
    };
  }
  // Cursor 0 lets the initial app build its transcript from the Journal. No
  // separate in-memory history injection is needed during boot.
  const firstStream = await openEventStream(fetchImpl, created.sessionId, 0);

  const state: SessionState = {
    ...created,
    eventsStream: firstStream,
    streamVersion: 0,
  };

  // 2. Session switching ---------------------------------------------------
  const newSession = async (): Promise<void> => {
    const next = await createSessionOnServer(fetchImpl, opts);
    const stream = await openEventStream(fetchImpl, next.sessionId, 0);
    state.sessionId = next.sessionId;
    state.contextWindow = next.contextWindow;
    state.mcpServers = next.mcpServers;
    state.commands = next.commands;
    state.inputDelivery = next.inputDelivery;
    state.eventsStream = stream;
    state.streamVersion += 1;
  };

  const listSessions = async (): Promise<ReadonlyArray<SessionInfo>> => {
    const res = await fetchImpl(`${BASE}/sessions`);
    if (!res.ok) {
      throw new Error(
        `niuma: session list failed (${res.status}) ${await safeText(res)}`,
      );
    }
    return decode(SessionListRes)(await res.json());
  };

  const listSessionIds = async (): Promise<ReadonlyArray<string>> => {
    const res = await fetchImpl(`${BASE}/sessions/ids`);
    if (!res.ok) {
      throw new Error(
        `niuma: session id list failed (${res.status}) ${await safeText(res)}`,
      );
    }
    return decode(SessionIdListRes)(await res.json());
  };

  const resume = async (sessionId: string): Promise<ResumeResult> => {
    const payload = await getSessionOnServer(fetchImpl, sessionId);
    const history = payload.history;
    // The server replays `seq >= cursor`, so start strictly AFTER the last
    // recorded event to avoid re-delivering history on the new stream.
    const nextCursor = history.reduce(
      (max, event) => Math.max(max, event.seq),
      0,
    ) + 1;
    const stream = await openEventStream(fetchImpl, sessionId, nextCursor);
    state.sessionId = sessionId;
    state.contextWindow = payload.contextWindow ?? null;
    state.mcpServers = payload.mcpServers;
    state.commands = payload.commands;
    state.inputDelivery = payload.clientConfig.inputDelivery;
    state.eventsStream = stream;
    state.streamVersion += 1;
    return { info: payload.info, history };
  };

  // 3. Mutators (always target the CURRENT session) ------------------------
  const prompt = async (text: string): Promise<PromptResult> => {
    try {
      const res = await fetchImpl(
        `${BASE}/sessions/${enc(state.sessionId)}/prompt`,
        {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ text }),
        },
      );
      const responseText = await safeText(res);
      if (!res.ok) {
        const { code, message } = errorFields(responseText);
        return {
          ok: false,
          status: res.status,
          ...(code !== undefined ? { code } : {}),
          error: message ?? (responseText || `prompt failed (${res.status})`),
        };
      }
      const body = decode(PromptResponse)(tryParseJson(responseText));
      return { ok: true, status: res.status, disposition: body.disposition };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  const approve = (
    approvalId: string,
    decision: ApprovalDecision,
    feedback?: string,
  ): Promise<ClientResult> =>
    request(
      fetchImpl,
      "POST",
      `${BASE}/sessions/${enc(state.sessionId)}/approvals/${enc(approvalId)}`,
      feedback !== undefined ? { decision, feedback } : { decision },
    );

  const interrupt = async (): Promise<InterruptResult> => {
    try {
      const res = await fetchImpl(
        `${BASE}/sessions/${enc(state.sessionId)}/interrupt`,
        { method: "POST", headers: jsonHeaders, body: "{}" },
      );
      const responseText = await safeText(res);
      if (!res.ok) {
        const { code, message } = errorFields(responseText);
        return {
          ok: false,
          status: res.status,
          returnedInputs: [],
          ...(code !== undefined ? { code } : {}),
          error: message ??
            (responseText || `interrupt failed (${res.status})`),
        };
      }
      const body = decode(InterruptResponse)(tryParseJson(responseText));
      return {
        ok: true,
        status: res.status,
        returnedInputs: body.returnedInputs,
      };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        returnedInputs: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  // 4. Built-in command endpoints (model / effort / compact) ----------------
  const setModel = async (model: string): Promise<SetModelResult> => {
    try {
      const res = await fetchImpl(
        `${BASE}/sessions/${enc(state.sessionId)}/model`,
        {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ model }),
        },
      );
      const text = await safeText(res);
      if (!res.ok) {
        const { code, message } = errorFields(text);
        return {
          ok: false,
          ...(code !== undefined ? { code } : {}),
          error: message ?? (text || `set model failed (${res.status})`),
        };
      }
      const body = decode(SetModelResponse)(tryParseJson(text));
      const contextWindow = typeof body.contextWindow === "number" &&
          Number.isFinite(body.contextWindow) && body.contextWindow > 0
        ? body.contextWindow
        : undefined;
      // Keep the getter in sync with the model the session now runs.
      if (contextWindow !== undefined) state.contextWindow = contextWindow;
      return {
        ok: true,
        model: body.model,
        ...(contextWindow !== undefined ? { contextWindow } : {}),
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  const setEffort = async (effort: string): Promise<SetEffortResult> => {
    try {
      const res = await fetchImpl(
        `${BASE}/sessions/${enc(state.sessionId)}/effort`,
        {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ effort }),
        },
      );
      const text = await safeText(res);
      if (!res.ok) {
        const { code, message } = errorFields(text);
        return {
          ok: false,
          ...(code !== undefined ? { code } : {}),
          error: message ?? (text || `set effort failed (${res.status})`),
        };
      }
      const body = decode(SetEffortResponse)(tryParseJson(text));
      return { ok: true, effort: body.effort };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  const renameTitle = async (title: string): Promise<SetTitleResult> => {
    try {
      const res = await fetchImpl(
        `${BASE}/sessions/${enc(state.sessionId)}/title`,
        {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ title }),
        },
      );
      const text = await safeText(res);
      if (!res.ok) {
        const { code, message } = errorFields(text);
        return {
          ok: false,
          ...(code !== undefined ? { code } : {}),
          error: message ?? (text || `rename failed (${res.status})`),
        };
      }
      const body = decode(SetTitleResponse)(tryParseJson(text));
      return { ok: true, title: body.title };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  const setInputDelivery = async (
    inputDelivery: InputDelivery,
  ): Promise<SetInputDeliveryResult> => {
    try {
      const res = await fetchImpl(`${BASE}/config/input-delivery`, {
        method: "PUT",
        headers: jsonHeaders,
        body: JSON.stringify({ inputDelivery }),
      });
      const responseText = await safeText(res);
      if (!res.ok) {
        const { code, message } = errorFields(responseText);
        return {
          ok: false,
          ...(code !== undefined ? { code } : {}),
          error: message ??
            (responseText || `delivery update failed (${res.status})`),
        };
      }
      const body = decode(SetInputDeliveryResponse)(
        tryParseJson(responseText),
      );
      state.inputDelivery = body.config.inputDelivery;
      return { ok: true, inputDelivery: state.inputDelivery };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  const compact = async (): Promise<CompactResult> => {
    try {
      const res = await fetchImpl(
        `${BASE}/sessions/${enc(state.sessionId)}/compact`,
        { method: "POST", headers: jsonHeaders, body: "{}" },
      );
      const text = await safeText(res);
      if (res.ok) return { ok: true };
      const { code, message } = errorFields(text);
      return {
        ok: false,
        ...(code !== undefined ? { code } : {}),
        error: message ?? (text || `compact failed (${res.status})`),
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  const subagentHistory = async (
    sessionId: string,
  ): Promise<ReadonlyArray<RecordedEvent>> => {
    const res = await fetchImpl(`${BASE}/sessions/${enc(sessionId)}/history`);
    if (!res.ok) {
      throw new Error(
        `niuma: subagent history failed (${res.status}) ${await safeText(res)}`,
      );
    }
    const body = tryParseJson(await safeText(res)) as
      | { events?: unknown }
      | undefined;
    if (!Array.isArray(body?.events)) {
      throw new Error("niuma: subagent history malformed");
    }
    return body.events as RecordedEvent[];
  };

  const openSubagentStream = (
    sessionId: string,
    cursor: number,
  ): Promise<ReadableStream<Uint8Array>> =>
    openEventStream(fetchImpl, sessionId, cursor);

  return {
    get sessionId() {
      return state.sessionId;
    },
    get contextWindow() {
      return state.contextWindow;
    },
    get mcpServers() {
      return state.mcpServers;
    },
    get commands() {
      return state.commands;
    },
    get inputDelivery() {
      return state.inputDelivery;
    },
    get eventsStream() {
      return state.eventsStream;
    },
    get streamVersion() {
      return state.streamVersion;
    },
    prompt,
    approve,
    interrupt,
    newSession,
    listSessions,
    listSessionIds,
    resume,
    setModel,
    setEffort,
    renameTitle,
    setInputDelivery,
    compact,
    subagentHistory,
    openSubagentStream,
  };
};

/**
 * POST JSON and resolve to a `ClientResult` (never throws — the app decides
 * how to react to a non-ok status via the returned fields).
 */
const request = async (
  fetchImpl: typeof fetch,
  method: string,
  url: string,
  body: unknown,
): Promise<ClientResult> => {
  try {
    const res = await fetchImpl(url, {
      method,
      headers: jsonHeaders,
      body: JSON.stringify(body),
    });
    const text = await safeText(res);
    return { ok: res.ok, status: res.status, body: text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, body: msg };
  }
};
