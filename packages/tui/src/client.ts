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
//   - `listSessions()` is `GET /sessions` (projection read model).
//   - `resume(id)` is `GET /sessions/:id` -> { info, history }, then re-opens
//     the SSE stream at `max(history.seq) + 1` so the live tail never
//     re-delivers an event already present in the returned history (the
//     server's replay emits `seq >= cursor`; see packages/server/src/
//     event_log.ts).
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
// Note: `contextWindow` / `mcpServers` / `commands` come from the session
// CREATE response; `GET /sessions/:id` does not return them, so `resume()`
// keeps the values from boot (they describe the workspace/boot environment,
// which a resumed session in the same workspace shares).
//
// The app owns the SSE consumption loop (a Sub that drives `reduceEvent`);
// `parseSseStream` is re-exported here so the app imports both from one
// place. The SSE parser itself lives in `packages/cli/src/sse.ts` (shared
// with the one-shot runner).
// ===========================================================================

import type { RecordedEvent, SessionInfo } from "@niuma/schema";

// Shared SSE frame parser (also used by the one-shot CLI runner). Imported by
// relative path so both packages share a single implementation; the app gets
// it via the re-export below.
export { parseSseStream, type SseFrame } from "../../cli/src/sse.ts";

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
}

/** The payload `resume()` hands back: the session's projection row plus its
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
   * knows it (drives the status line's context-usage percentage). */
  readonly contextWindow: number | null;
  /** MCP servers the server connected at boot (id + contributed tool count).
   * Empty when none are configured. */
  readonly mcpServers: ReadonlyArray<{ id: string; toolCount: number }>;
  /** Custom slash commands visible to the current session (user + project
   * commands/*.md). Empty when none are defined. */
  readonly commands: ReadonlyArray<ClientCommand>;
  /** The CURRENT open SSE `/events` body; the app consumes it via
   * `parseSseStream`. Replaced on session switch — pair with
   * `streamVersion`. */
  readonly eventsStream: ReadableStream<Uint8Array>;
  /** Monotonically increasing stream generation: starts at 0, +1 per
   * successful newSession/resume. Consumers poll this to know when to drop
   * the old pump and re-read `eventsStream` (see the banner contract). */
  readonly streamVersion: number;
  /** Submit a prompt to the current session (kicks off an agent turn). */
  readonly prompt: (text: string) => Promise<ClientResult>;
  /** Resolve a pending approval of the current session. */
  readonly approve: (
    approvalId: string,
    decision: ApprovalDecision,
    feedback?: string,
  ) => Promise<ClientResult>;
  /** Interrupt the current session's in-flight turn (ctrl+c). */
  readonly interrupt: () => Promise<ClientResult>;
  /** Create a fresh session and switch to it (SSE re-opened at cursor 0,
   * `streamVersion` bumped). Rejects on a server/stream failure. */
  readonly newSession: () => Promise<void>;
  /** List known sessions (projection read model) for the /resume picker. */
  readonly listSessions: () => Promise<ReadonlyArray<SessionInfo>>;
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
  /** Ask the server to compact the current session's context. Rejected with
   * `code: "turn_in_flight"` while a turn is active. */
  readonly compact: () => Promise<CompactResult>;
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
  eventsStream: ReadableStream<Uint8Array>;
  streamVersion: number;
}

/** POST /sessions and parse the create response into SessionState fields. */
const createSessionOnServer = async (
  fetchImpl: typeof fetch,
  opts: TuiClientOptions,
): Promise<
  Pick<SessionState, "sessionId" | "contextWindow" | "mcpServers" | "commands">
> => {
  const createBody: Record<string, unknown> = { workspace: opts.workspace };
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
    const created = (await res.json()) as {
      sessionId?: string;
      contextWindow?: number;
      mcpServers?: Array<{ id: string; toolCount: number }>;
      commands?: Array<{
        name?: unknown;
        description?: unknown;
        argumentHint?: unknown;
      }>;
    };
    if (typeof created.sessionId !== "string") {
      throw new Error("session create returned no sessionId");
    }
    // Older servers omit these; treat both as "unknown / none" rather than
    // failing the boot.
    const contextWindow = typeof created.contextWindow === "number" &&
        Number.isFinite(created.contextWindow) && created.contextWindow > 0
      ? created.contextWindow
      : null;
    const mcpServers = Array.isArray(created.mcpServers)
      ? created.mcpServers.filter(
        (s): s is { id: string; toolCount: number } =>
          typeof s?.id === "string" && typeof s?.toolCount === "number",
      )
      : [];
    const commands = Array.isArray(created.commands)
      ? created.commands.filter(
        (c): c is ClientCommand => typeof c?.name === "string",
      )
      : [];
    return {
      sessionId: created.sessionId,
      contextWindow,
      mcpServers,
      commands,
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the first session and open its SSE stream, then return a session
 * manager bound to that session. Resolves once both have succeeded (the
 * stream is open but NOT yet consumed — the app starts a Sub for that).
 * Rejects on a session-create or stream-open failure so `runTui` can surface
 * a non-zero exit code.
 */
export const createTuiClient = async (
  fetchImpl: typeof fetch,
  opts: TuiClientOptions,
): Promise<TuiClient> => {
  // 1. Create the initial session + open its stream (same boot ordering as
  // before: stream open BEFORE any prompt so no early event is missed).
  const created = await createSessionOnServer(fetchImpl, opts);
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
    const list = (await res.json()) as unknown;
    return Array.isArray(list) ? list as SessionInfo[] : [];
  };

  const resume = async (sessionId: string): Promise<ResumeResult> => {
    const res = await fetchImpl(`${BASE}/sessions/${enc(sessionId)}`);
    if (!res.ok) {
      throw new Error(
        `niuma: session resume failed (${res.status}) ${await safeText(res)}`,
      );
    }
    const payload = (await res.json()) as {
      info?: SessionInfo;
      history?: ReadonlyArray<RecordedEvent>;
    };
    if (payload.info === undefined || typeof payload.info !== "object") {
      throw new Error(`niuma: session ${sessionId} not found`);
    }
    const history = Array.isArray(payload.history) ? payload.history : [];
    // The server replays `seq >= cursor`, so start strictly AFTER the last
    // recorded event to avoid re-delivering history on the new stream.
    const nextCursor = history.reduce(
      (max, e) =>
        typeof (e as { seq?: unknown } | null)?.seq === "number"
          ? Math.max(max, (e as { seq: number }).seq)
          : max,
      0,
    ) + 1;
    const stream = await openEventStream(fetchImpl, sessionId, nextCursor);
    state.sessionId = sessionId;
    // contextWindow/mcpServers/commands are boot/workspace-scoped (see the
    // banner): resume keeps the values captured at create time.
    state.eventsStream = stream;
    state.streamVersion += 1;
    return { info: payload.info, history };
  };

  // 3. Mutators (always target the CURRENT session) ------------------------
  const prompt = (text: string): Promise<ClientResult> =>
    request(
      fetchImpl,
      "POST",
      `${BASE}/sessions/${enc(state.sessionId)}/prompt`,
      { text },
    );

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

  const interrupt = (): Promise<ClientResult> =>
    request(
      fetchImpl,
      "POST",
      `${BASE}/sessions/${enc(state.sessionId)}/interrupt`,
      {},
    );

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
      const body = tryParseJson(text) as
        | { model?: unknown; contextWindow?: unknown }
        | undefined;
      const contextWindow = typeof body?.contextWindow === "number" &&
          Number.isFinite(body.contextWindow) && body.contextWindow > 0
        ? body.contextWindow
        : undefined;
      // Keep the getter in sync with the model the session now runs.
      if (contextWindow !== undefined) state.contextWindow = contextWindow;
      return {
        ok: true,
        ...(typeof body?.model === "string" ? { model: body.model } : {}),
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
      const body = tryParseJson(text) as { effort?: unknown } | undefined;
      return {
        ok: true,
        ...(typeof body?.effort === "string" ? { effort: body.effort } : {}),
      };
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
    resume,
    setModel,
    setEffort,
    compact,
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
