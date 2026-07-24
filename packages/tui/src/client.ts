// ===========================================================================
// @niuma/tui — live session client (INPUT/ORCHESTRATION half)
// ---------------------------------------------------------------------------
// `TuiClient` is the TUI's thin HTTP client over the tunnelled server. It
// mirrors the one-shot ordering in `packages/cli/src/run.ts`:
//
//   1. POST /sessions                -> { sessionId }
//   2. GET  /events?session=<id>&cursor=0   (opened BEFORE the first prompt
//      so an early approval.requested or text.delta is never missed)
//   3. (later) POST /sessions/:id/prompt    per submitted editor text
//   4. POST /sessions/:id/approvals/:aid    on a y/a/n decision
//   5. POST /sessions/:id/interrupt          on ctrl+c while streaming
//
// The app owns the SSE consumption loop (a Sub that drives `reduceEvent`);
// `client.eventsStream` exposes the open SSE body and `parseSseStream` is
// re-exported here so the app imports both from one place. The SSE parser
// itself lives in `packages/cli/src/sse.ts` (shared with the one-shot runner).
// ===========================================================================

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

export interface ClientResult {
  readonly ok: boolean;
  readonly status: number;
  readonly body: string;
}

export interface TuiClientOptions {
  readonly workspace: string;
  /** Bare model id recorded on the session; omit for the mock provider. */
  readonly model?: string;
}

export interface TuiClient {
  /** The session this client is bound to. */
  readonly sessionId: string;
  /** The open SSE `/events` body; the app consumes it via `parseSseStream`. */
  readonly eventsStream: ReadableStream<Uint8Array>;
  /** Submit a prompt (kicks off an agent turn). */
  readonly prompt: (text: string) => Promise<ClientResult>;
  /** Resolve a pending approval with the user's decision. */
  readonly approve: (
    approvalId: string,
    decision: ApprovalDecision,
    feedback?: string,
  ) => Promise<ClientResult>;
  /** Interrupt the in-flight turn (ctrl+c while streaming). */
  readonly interrupt: () => Promise<ClientResult>;
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a session and open the SSE stream. Resolves once both have succeeded
 * (the stream is open but NOT yet consumed — the app starts a Sub for that).
 * Rejects on a session-create or stream-open failure so `runTui` can surface a
 * non-zero exit code.
 */
export const createTuiClient = async (
  fetchImpl: typeof fetch,
  opts: TuiClientOptions,
): Promise<TuiClient> => {
  // 1. Create session ------------------------------------------------------
  let sessionId: string;
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
    const created = (await res.json()) as { sessionId?: string };
    if (typeof created.sessionId !== "string") {
      throw new Error("session create returned no sessionId");
    }
    sessionId = created.sessionId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`niuma: session create error: ${msg}`);
  }

  // 2. Open the SSE stream BEFORE prompting --------------------------------
  const eventsUrl = `${BASE}/events?session=${enc(sessionId)}&cursor=0`;
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
  const eventsStream = sseRes.body;

  // 3. Mutators ------------------------------------------------------------
  const prompt = (text: string): Promise<ClientResult> =>
    request(fetchImpl, "POST", `${BASE}/sessions/${enc(sessionId)}/prompt`, {
      text,
    });

  const approve = (
    approvalId: string,
    decision: ApprovalDecision,
    feedback?: string,
  ): Promise<ClientResult> =>
    request(
      fetchImpl,
      "POST",
      `${BASE}/sessions/${enc(sessionId)}/approvals/${enc(approvalId)}`,
      feedback !== undefined ? { decision, feedback } : { decision },
    );

  const interrupt = (): Promise<ClientResult> =>
    request(
      fetchImpl,
      "POST",
      `${BASE}/sessions/${enc(sessionId)}/interrupt`,
      {},
    );

  return { sessionId, eventsStream, prompt, approve, interrupt };
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
