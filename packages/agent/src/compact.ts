// ============================================================================
// compactSession — standalone compaction entry point (the /compact command
// path). Unlike the in-turn compactNow (loop.ts), which trims the live
// message list when the context estimate crosses the threshold, this replays
// a session's event log, summarizes the whole history, and appends a
// summary-bearing compaction.performed event. The compression persists
// across turns: the next replay folds the event into the bridge message
// (context.ts projectEvent), so the compacted prefix is never re-sent.
//
// Deps are the minimal subset of RunTurnDeps needed for the job: the event
// log (replay + append) and a provider + model for the LLM summary. No
// tools, approvals, or system prompt — the summarizer call is tool-free and
// system-free (see compaction.ts summarizeHistory).
// ============================================================================

import { Effect, Result } from "effect";
import type { ProviderAdapter } from "@niuma/provider";
import type { EventLog } from "./deps.ts";
import { eventsToMessages } from "./context.ts";
import { buildSummary, summarizeHistory } from "./compaction.ts";

export interface CompactSessionDeps {
  readonly event_log: EventLog;
  readonly provider: ProviderAdapter;
  readonly model: string;
  readonly signal?: AbortSignal;
}

export interface CompactSessionResult {
  // false ⇒ nothing was recorded (too few user turns to be worth folding).
  readonly compacted: boolean;
  // Present only when compacted. "llm" = model-written handoff summary;
  // "template" = deterministic fallback (summary call failed or empty).
  readonly mode?: "llm" | "template";
}

// Same keepUserTurns default as the in-turn path (loop.ts compactNow /
// compactMessages): with this many user turns or fewer there is no older
// prefix worth folding away.
const KEEP_USER_TURNS = 2;

export function compactSession(
  sessionId: string,
  deps: CompactSessionDeps,
): Effect.Effect<CompactSessionResult> {
  return Effect.gen(function* () {
    const events = yield* deps.event_log.replay(sessionId);
    const messages = eventsToMessages(events);

    // No-op guard, mirroring compactMessages: not enough user turns → skip
    // without recording anything.
    const userTurns = messages.filter((m) => m.role === "user").length;
    if (userTurns <= KEEP_USER_TURNS) return { compacted: false };

    // LLM summary preferred; any failure (or empty text) falls back to the
    // deterministic template, exactly like the in-turn path.
    const summarizeResult = yield* summarizeHistory(
      {
        provider: deps.provider,
        model: deps.model,
        ...(deps.signal ? { signal: deps.signal } : {}),
      },
      messages,
    ).pipe(Effect.result);
    const llmText = Result.isSuccess(summarizeResult)
      ? summarizeResult.success
      : null;
    const mode = llmText !== null ? ("llm" as const) : ("template" as const);
    const body = llmText ?? buildSummary(events);

    yield* deps.event_log.append(sessionId, {
      type: "compaction.performed",
      data: { summaryMessageId: crypto.randomUUID(), mode, summary: body },
    });
    return { compacted: true, mode };
  });
}
