// One-shot runner.
//
// Implements the MANUAL permission UX:
//   - POST /sessions to create a session
//   - GET /events?session=<id>&cursor=0 to open the SSE stream (before
//     prompting so we never miss an early event)
//   - POST /sessions/:id/prompt to kick off the agent turn
//   - For each approval.requested event: prompt on stdin
//       y = allow once    a = always (synthesize a rule)    n = reject
//     then POST /sessions/:id/approvals/:approvalId with the decision
//   - When turn.completed (or turn.aborted) arrives, stop reading,
//     print the most recent assistant.message text to stdout, and exit.
//
// All diagnostics (tool call logs, errors, approval prompts) go to stderr
// so stdout contains exactly the final assistant text.

import { decode, parseSseStream, SseEvent as WireSseEvent } from "@niuma/schema";
import { readStdinLine } from "./stdin.ts";

// Fake host used by the tunnel — Hono routes on the path; the host is
// arbitrary. Re-using the same constant the smoke tests use keeps things
// consistent.
const BASE = "http://niuma.internal";

export interface RunOptions {
  readonly prompt: string;
  readonly workspace: string;
  /** Bare model id recorded on the session. Omitted under the mock provider
   * so the server falls back to the same literal "default" the server smoke
   * tests use (the scripted mock accepts any model). */
  readonly model?: string;
  /** Suppress non-essential stderr output (tool call banners, etc.). */
  readonly quiet?: boolean;
}

export interface RunResult {
  readonly exitCode: number;
  readonly sessionId: string | undefined;
  readonly finalText: string;
}

/**
 * Run a one-shot prompt against the tunnelled server and return the exit
 * code plus the final assistant text. The caller is responsible for
 * terminating the worker and calling Deno.exit.
 */
export const runOneshot = async (
  opts: RunOptions,
  fetchImpl: typeof fetch,
): Promise<RunResult> => {
  const stderr = (line: string) => {
    if (!opts.quiet) console.error(line);
  };

  // ---- 1. Create session --------------------------------------------------
  let sessionId: string | undefined;
  try {
    const res = await fetchImpl(`${BASE}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace: opts.workspace,
        ...(opts.model !== undefined ? { model: opts.model } : {}),
      }),
    });
    if (!res.ok) {
      const body = await safeText(res);
      console.error(
        `niuma: failed to create session (${res.status}) ${body}`,
      );
      return { exitCode: 1, sessionId: undefined, finalText: "" };
    }
    const created = (await res.json()) as { sessionId: string };
    sessionId = created.sessionId;
  } catch (err) {
    console.error(`niuma: session create error: ${errorMessage(err)}`);
    return { exitCode: 1, sessionId: undefined, finalText: "" };
  }

  // ---- 2. Open the SSE stream BEFORE prompting ----------------------------
  // Cursor 0 replays session.created + the upcoming turn events. Opening
  // first guarantees we do not miss a quick approval.requested that fires
  // between prompt() and the GET.
  const eventsUrl = `${BASE}/events?session=${
    encodeURIComponent(sessionId)
  }&cursor=0`;
  let sseRes: Response;
  try {
    sseRes = await fetchImpl(eventsUrl);
  } catch (err) {
    console.error(`niuma: events stream error: ${errorMessage(err)}`);
    return { exitCode: 1, sessionId, finalText: "" };
  }
  if (!sseRes.ok || !sseRes.body) {
    const body = await safeText(sseRes);
    console.error(`niuma: events stream failed (${sseRes.status}) ${body}`);
    return { exitCode: 1, sessionId, finalText: "" };
  }

  // ---- 3. Submit the prompt ----------------------------------------------
  try {
    const res = await fetchImpl(
      `${BASE}/sessions/${encodeURIComponent(sessionId)}/prompt`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: opts.prompt }),
      },
    );
    if (!res.ok) {
      const body = await safeText(res);
      console.error(`niuma: prompt rejected (${res.status}) ${body}`);
      return { exitCode: 1, sessionId, finalText: "" };
    }
  } catch (err) {
    console.error(`niuma: prompt error: ${errorMessage(err)}`);
    return { exitCode: 1, sessionId, finalText: "" };
  }

  // ---- 4. Consume the SSE stream until the turn ends ----------------------
  let finalText = "";
  let exitCode = 0;
  let done = false;

  try {
    for await (const frame of parseSseStream(sseRes.body)) {
      // Heartbeat from the events handler — ignore.
      if (frame.event === "ping") continue;

      const event = decode(WireSseEvent)({
        cursor: Number(frame.id),
        event: JSON.parse(frame.data),
      }).event;
      // The frame has been validated against the closed recorded/live event
      // union. One-shot mode consumes only a few variants and deliberately
      // ignores the rest below.
      const type = event.type;
      const data = event.data as Readonly<Record<string, unknown>>;

      switch (type) {
        case "assistant.message": {
          const parts = (data["parts"] as
            | Array<{ type: string; text?: string }>
            | undefined) ?? [];
          const text = parts
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join("");
          if (text.length > 0) finalText = text;
          break;
        }
        case "tool.call.requested": {
          const name = typeof data["name"] === "string" ? data["name"] : "tool";
          stderr(`→ ${name}`);
          break;
        }
        case "tool.call.denied": {
          const reason = typeof data["reason"] === "string"
            ? data["reason"]
            : "permission denied";
          stderr(`✗ denied: ${reason}`);
          break;
        }
        case "approval.requested": {
          const approvalId = typeof data["approvalId"] === "string"
            ? data["approvalId"]
            : undefined;
          const name = typeof data["name"] === "string" ? data["name"] : "tool";
          if (!approvalId) break;
          const decision = await promptApproval(name, data["input"]);
          try {
            const res = await fetchImpl(
              `${BASE}/sessions/${encodeURIComponent(sessionId)}/approvals/${
                encodeURIComponent(approvalId)
              }`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(decision),
              },
            );
            if (!res.ok) {
              const body = await safeText(res);
              console.error(
                `niuma: approval POST failed (${res.status}) ${body}`,
              );
            }
          } catch (err) {
            console.error(
              `niuma: approval POST error: ${errorMessage(err)}`,
            );
          }
          break;
        }
        case "error.occurred": {
          const message = typeof data["message"] === "string"
            ? data["message"]
            : "(no detail)";
          console.error(`niuma: agent error: ${message}`);
          break;
        }
        case "turn.aborted": {
          const reason = typeof data["reason"] === "string"
            ? data["reason"]
            : "unknown reason";
          console.error(`niuma: turn aborted (${reason})`);
          exitCode = 1;
          done = true;
          break;
        }
        case "turn.completed": {
          // recordTerminal emits turn.completed with stopReason "error" when a
          // turn dies on a provider failure (retry exhaustion, AuthFailed, …).
          // That is a failed turn, not a successful one — surface it via a
          // non-zero exit code so scripts/CI gating on `$?` do not silently
          // pass on empty stdout. The diagnostic itself was already printed by
          // the preceding error.occurred event.
          if (data["stopReason"] === "error") exitCode = 1;
          done = true;
          break;
        }
        default:
          // Other recorded events (session.created, user.message,
          // tool.result, compaction.performed, ...) and live events
          // (text.delta, tool.progress) are intentionally ignored in
          // one-shot mode to keep stdout clean.
          break;
      }

      if (done) break;
    }
  } catch (err) {
    console.error(`niuma: event stream error: ${errorMessage(err)}`);
    return { exitCode: 1, sessionId, finalText };
  }

  // ---- 5. Print final assistant text to stdout ----------------------------
  if (finalText.length > 0) {
    // console.log adds a trailing newline — matches typical CLI output.
    console.log(finalText);
  }

  return { exitCode, sessionId, finalText };
};

// ---------------------------------------------------------------------------
// Approval prompt
// ---------------------------------------------------------------------------

type ApprovalDecision = {
  decision: "once" | "always" | "reject";
  feedback?: string;
};

const promptApproval = async (
  name: string,
  input: unknown,
): Promise<ApprovalDecision> => {
  const preview = formatInputPreview(input);
  console.error("");
  console.error(`┌─ approval required: ${name}`);
  if (preview.length > 0) {
    for (const line of preview.split("\n")) {
      console.error(`│ ${line}`);
    }
  }
  console.error("└─ (y) once / (a) always / (n) reject");
  Deno.stderr.writeSync(new TextEncoder().encode("choice> "));

  const line = await readStdinLine();
  const trimmed = (line ?? "").trim().toLowerCase();
  const head = trimmed[0];

  switch (head) {
    case "y":
      return { decision: "once" };
    case "a":
      return { decision: "always" };
    case "n":
      return { decision: "reject" };
    default:
      console.error("niuma: no valid choice — rejecting");
      return { decision: "reject", feedback: "no user choice" };
  }
};

const formatInputPreview = (input: unknown): string => {
  if (input === undefined || input === null) return "";
  let text: string;
  if (typeof input === "string") {
    text = input;
  } else {
    try {
      text = JSON.stringify(input);
    } catch {
      text = String(input);
    }
  }
  const MAX = 480;
  const truncated = text.length > MAX
    ? `${text.slice(0, MAX)}… (+${text.length - MAX} more chars)`
    : text;
  return truncated;
};

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

const errorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
};
