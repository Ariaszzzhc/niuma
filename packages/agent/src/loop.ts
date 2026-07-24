import { Effect, Result, Stream } from "effect";
import type { Part, RecordedEvent, StopReason, Usage } from "@niuma/schema";
import type {
  ChatRequest,
  Message as ProviderMessage,
  ProviderError,
  StreamEvent as ProviderStreamEvent,
  Usage as ProviderUsage,
} from "@niuma/provider";
import { isRetryable, STREAM_MAX_RETRIES } from "@niuma/provider";
import type {
  EventInput,
  RunTurnDeps,
  ToolCallRequest,
  ToolMode,
} from "./deps.ts";
import { buildSystemPrompt } from "./prompt.ts";
import {
  estimateRequestTokens,
  eventsToMessages,
  projectEvent,
} from "./context.ts";
import {
  buildSummary,
  compactMessages,
  summarizeHistory,
  SUMMARY_PREFIX,
} from "./compaction.ts";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const COMPACT_RATIO = 0.85;
const MAX_ITERATIONS = 100;

// ============================================================================
// Fix D — Incremental projection (replay once per turn)
//
// Message-relevant recorded events are exactly user.message | assistant.message
// | tool.result (context.ts eventsToMessages / projectEvent; every other type
// hits `default`). Within a single runTurn invocation, every such event is
// appended by this loop itself, synchronously in its own fiber:
//   - user.message: drained from the steer queue and appended at the loop top;
//   - assistant.message / tool.result: appended after sampling / running tools.
// No external writer appends message-relevant events to an in-flight turn —
// steer() is drained (and appended) here, and AgentSession.prompt / the server
// runAgentTurn / subagent seeder append user.message BEFORE invoking runTurn,
// so the single pre-loop replay picks them up. Therefore the log is replayed
// ONCE per turn and the message list is maintained incrementally by mirroring
// each appended event (append+mirror wrapper below). This drops the per-
// iteration replay — O(n²) over a growing JSONL — to one O(n) replay plus O(1)
// per-iteration appends. historyEvents is mirrored at the same append sites so
// buildSummary (which scans tool.call.requested) sees the same input a fresh
// replay would yield.
// ============================================================================

export interface TurnResult {
  readonly stopReason: StopReason;
  readonly usage: Usage;
  readonly text: string;
  // Present only when the turn terminated on a provider/stream error
  // (stopReason === "error"). Carries the human-readable terminal message.
  readonly error?: string;
}

interface Steered {
  readonly drainInput?: () => ReadonlyArray<ReadonlyArray<Part>>;
}

const zeroUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0 });

const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
});

const mapUsage = (u?: ProviderUsage): Usage =>
  u
    ? {
      inputTokens: u.promptTokens ?? 0,
      outputTokens: u.completionTokens ?? 0,
    }
    : zeroUsage();

const parseInput = (args: string): unknown => {
  const s = args.trim();
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return { _raw: args };
  }
};

interface SampleResult {
  readonly text: string;
  readonly toolCalls: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly arguments: string;
  }>;
  readonly stopReason: StopReason;
  readonly usage: Usage;
}

// Human-readable rendering of a provider error for error.occurred / TurnResult.
// _tag always; plus `message`/`retryAfterMs` when the variant carries them.
// Never JSON.stringify the raw object — Network.cause is often a huge/opaque
// Error and dumping it pollutes the event log.
const errorMessage = (e: ProviderError): string => {
  const parts: string[] = [e._tag];
  switch (e._tag) {
    case "Overloaded":
    case "ContextOverflow":
    case "AuthFailed":
      if (e.message) parts.push(e.message);
      break;
    case "InvalidResponse":
      parts.push(e.message);
      break;
    case "RateLimited":
      if (e.retryAfterMs !== undefined) {
        parts.push(`retryAfterMs=${e.retryAfterMs}`);
      }
      break;
    case "Network":
      break;
  }
  return parts.join(": ");
};

// Runs one provider stream to completion, accumulating text (emitted live as
// text.delta) and complete tool calls. The provider adapter already coalesces
// tool_call deltas, so calls arrive whole.
const runStreamOnce = (
  deps: RunTurnDeps,
  sessionId: string,
  req: ChatRequest,
  acc: {
    text: string;
    toolCalls: SampleResult["toolCalls"][number][];
    stopReason: { v: StopReason };
    usage: { v: Usage };
    emittedAny: { v: boolean };
  },
): Effect.Effect<void, ProviderError> =>
  deps.provider.stream(req).pipe(
    Stream.runForEach((ev: ProviderStreamEvent) =>
      Effect.sync(() => {
        switch (ev._tag) {
          case "TextDelta": {
            acc.text += ev.text;
            acc.emittedAny.v = true;
            deps.emitLive?.({
              type: "text.delta",
              ts: Date.now(),
              sessionId,
              data: { delta: ev.text },
            });
            break;
          }
          case "ToolCall": {
            acc.toolCalls.push({
              id: ev.id,
              name: ev.name,
              arguments: ev.arguments,
            });
            break;
          }
          case "Finish": {
            acc.stopReason.v = ev.reason;
            acc.usage.v = mapUsage(ev.usage);
            break;
          }
        }
      })
    ),
  );

// Samples the provider with a mid-stream retry policy (codex-style layer 2,
// complementing the transport-layer withRetry in openai.ts which only wraps
// the initial fetch). Retries Network/RateLimited/Overloaded up to
// STREAM_MAX_RETRIES times with exponential backoff + jitter. Partial
// text/tool_call deltas are discarded on every retry (locals reset), and a
// live-only text.reset event is emitted before re-sampling so clients clear
// their streaming buffer. Records only TRANSIENT retry error.occurred events
// (retryable: true); terminal failures fail upward for runTurn to record.
//
// `onRetry` is an optional observation hook fired after the transient event
// is logged and before the backoff sleep.
const sample = (
  deps: RunTurnDeps,
  sessionId: string,
  req: ChatRequest,
  onRetry?: (attempt: number, e: ProviderError) => Effect.Effect<void>,
): Effect.Effect<SampleResult, ProviderError> =>
  Effect.gen(function* () {
    const aborted = () => deps.signal?.aborted ?? false;
    let attempt = 0;
    // Sticky: once any attempt emitted partial text, every subsequent retry
    // resets the live buffer first (a prior attempt may have populated it).
    let hadPartialStream = false;

    while (true) {
      // Per-attempt locals — discarded on retry so nothing partial commits.
      const acc = {
        text: "",
        toolCalls: [] as SampleResult["toolCalls"][number][],
        stopReason: { v: "stop" as StopReason },
        usage: { v: zeroUsage() },
        emittedAny: { v: false },
      };

      const outcome = yield* runStreamOnce(deps, sessionId, req, acc).pipe(
        Effect.result,
      );

      if (Result.isSuccess(outcome)) {
        return {
          text: acc.text,
          toolCalls: acc.toolCalls,
          stopReason: acc.stopReason.v,
          usage: acc.usage.v,
        };
      }
      const e = outcome.failure;

      // Abort raised mid-stream: record nothing, surface abort (no retry).
      if (aborted()) {
        return {
          text: "",
          toolCalls: [],
          stopReason: "abort",
          usage: zeroUsage(),
        };
      }

      // Terminal for this sample: ContextOverflow (runTurn force-compacts),
      // any fatal error, or retry budget exhausted. Fail upward — runTurn's
      // terminal handler records the final error.occurred + turn.completed.
      if (
        e._tag === "ContextOverflow" ||
        !isRetryable(e) ||
        attempt >= STREAM_MAX_RETRIES
      ) {
        return yield* Effect.fail(e);
      }

      // Retryable: log a transient retry, reset the live buffer if this or a
      // prior attempt streamed any deltas, back off, then loop.
      attempt++;
      yield* deps.event_log.append(sessionId, {
        type: "error.occurred",
        data: {
          message: `${
            errorMessage(e)
          } (retry ${attempt}/${STREAM_MAX_RETRIES})`,
          retryable: true,
        },
      });
      if (acc.emittedAny.v || hadPartialStream) {
        deps.emitLive?.({
          type: "text.reset",
          ts: Date.now(),
          sessionId,
          data: {},
        });
        hadPartialStream = true;
      }
      if (onRetry) yield* onRetry(attempt, e);

      // RateLimited.retryAfterMs overrides the computed delay when present.
      const delay = e._tag === "RateLimited" && e.retryAfterMs !== undefined
        ? e.retryAfterMs
        : Math.min(200 * 2 ** (attempt - 1), 3200) *
          (0.9 + Math.random() * 0.2);
      yield* Effect.sleep(delay);
    }
  });

export function runTurn(
  sessionId: string,
  deps: RunTurnDeps & Steered,
): Effect.Effect<TurnResult> {
  const mode: ToolMode = deps.mode ?? "full";
  const contextWindow = deps.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const threshold = Math.floor(contextWindow * COMPACT_RATIO);
  const aborted = () => deps.signal?.aborted ?? false;

  return Effect.gen(function* () {
    const system = yield* Effect.promise(() =>
      buildSystemPrompt(deps.workspace)
    );
    const tools = deps.tools.defs(mode);

    let turnUsage = zeroUsage();
    let finalText = "";
    let stopReason: StopReason = "stop";

    // D: replay ONCE per turn, then maintain `messages`/`historyEvents` locally
    // (see header invariant). Within a turn only this loop appends message-
    // relevant events, so the local mirror stays an exact projection.
    const replayed = yield* deps.event_log.replay(sessionId);
    const historyEvents: RecordedEvent[] = [...replayed];
    let messages: ProviderMessage[] = eventsToMessages(historyEvents);

    // Append + mirror: every event the loop records is folded into the local
    // projection so neither `messages` nor `historyEvents` need re-deriving
    // from a fresh replay. Metadata events (turn.*, compaction.*, error.*,
    // approval.*, tool.call.requested) are pushed into historyEvents (keeping
    // buildSummary's view identical to a replay) and no-op'd for messages by
    // projectEvent. The `messages` binding is captured by reference, so a
    // reassignment from compaction is seen by subsequent calls.
    const append = (input: EventInput): Effect.Effect<RecordedEvent> =>
      Effect.gen(function* () {
        const ev = yield* deps.event_log.append(sessionId, input);
        historyEvents.push(ev);
        projectEvent(messages, ev);
        return ev;
      });

    // Fix B: compact `messages`, preferring an LLM-written handoff summary
    // (codex local path). Falls back to the deterministic template when the
    // summary call fails or returns empty/null. Records compaction.performed
    // with the mode used. The summary is wrapped as SUMMARY_PREFIX + "\n" +
    // body for BOTH modes so isSummaryMessage recognises any prior bridge
    // message regardless of mode (matches codex's single-marker design). The
    // summarizer sees the FULL pre-compaction message list — everything the
    // model knew — with no system prompt and no tools: cheap and focused. It
    // is sampled one-shot (transport withRetry still applies to the initial
    // fetch); failure → template, keeping worst-case latency bounded.
    const compactNow = (
      msgs: ReadonlyArray<ProviderMessage>,
      events: ReadonlyArray<RecordedEvent>,
      keepUserTurns = 2,
    ): Effect.Effect<ProviderMessage[]> =>
      Effect.gen(function* () {
        const summaryId = crypto.randomUUID();
        const summarizeResult = yield* summarizeHistory(
          {
            provider: deps.provider,
            model: deps.model,
            ...(deps.signal ? { signal: deps.signal } : {}),
          },
          msgs,
        ).pipe(Effect.result);
        const llmText = Result.isSuccess(summarizeResult)
          ? summarizeResult.success
          : null;
        const mode = llmText !== null
          ? ("llm" as const)
          : ("template" as const);
        const body = llmText ?? buildSummary(events);
        const summaryText = `${SUMMARY_PREFIX}\n${body}`;
        yield* append({
          type: "compaction.performed",
          data: { summaryMessageId: summaryId, mode },
        });
        return compactMessages(msgs, summaryText, keepUserTurns);
      });

    yield* append({ type: "turn.started", data: {} });

    const finishTurn = (reason: StopReason): Effect.Effect<RecordedEvent> =>
      append({
        type: "turn.completed",
        data: { stopReason: reason, usage: turnUsage },
      });

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      if (aborted()) {
        yield* append({
          type: "turn.aborted",
          data: { reason: "signal" },
        });
        return { stopReason: "abort", usage: turnUsage, text: finalText };
      }

      // Drain steer queue → append as user messages before sampling.
      const steered = deps.drainInput?.() ?? [];
      for (const parts of steered) {
        if (parts.length === 0) continue;
        yield* append({
          type: "user.message",
          data: { parts },
        });
      }

      // Pre-sampling token check → compact older history if over threshold.
      // Fix D side effect: because `messages` persists across iterations now,
      // a compacted list stays compacted — the check won't re-fire every loop
      // the way the old replay-every-iteration code did (which re-compacted
      // the full history each pass and appended duplicate compaction.performed
      // events while the conversation remained over threshold).
      let estimate = estimateRequestTokens(system, messages, tools);
      if (estimate > threshold) {
        messages = yield* compactNow(messages, historyEvents);
        estimate = estimateRequestTokens(system, messages, tools);
      }

      const baseReq: ChatRequest = {
        model: deps.model,
        system,
        messages,
        tools,
        ...(deps.maxTokens !== undefined ? { maxTokens: deps.maxTokens } : {}),
        ...(deps.temperature !== undefined
          ? { temperature: deps.temperature }
          : {}),
        ...(deps.signal ? { abort: deps.signal } : {}),
      };

      // Record the terminal error path: error.occurred (retryable: false) +
      // turn.completed (stopReason "error"). sample() records only transient
      // retry events, so the terminal one is recorded here to avoid duplication.
      const recordTerminal = (e: ProviderError): Effect.Effect<TurnResult> =>
        Effect.gen(function* () {
          yield* append({
            type: "error.occurred",
            data: { message: errorMessage(e), retryable: false },
          });
          yield* append({
            type: "turn.completed",
            data: { stopReason: "error", usage: turnUsage },
          });
          return {
            stopReason: "error",
            usage: turnUsage,
            text: finalText,
            error: errorMessage(e),
          };
        });

      type Outcome = { ok: SampleResult } | { failed: TurnResult };
      const toOk = (r: SampleResult): Outcome => ({ ok: r });
      const toFailed = (e: ProviderError): Effect.Effect<Outcome> =>
        Effect.map(recordTerminal(e), (failed): Outcome => ({ failed }));

      // sample() retries transient stream errors internally and only fails on
      // ContextOverflow / fatal / exhaustion. ContextOverflow force-compacts
      // and re-samples once (the re-sample carries its own retry loop + this
      // terminal handler); any other terminal failure ends the turn with
      // stopReason "error" and returns early.
      //
      // effect@4 beta dropped `Effect.catchAll`; `Effect.result` deterministically
      // erases the error channel and lets us branch on the typed ProviderError.
      const outcome: Outcome = yield* Effect.gen(function* () {
        const first = yield* sample(deps, sessionId, baseReq).pipe(
          Effect.result,
        );
        if (Result.isSuccess(first)) return toOk(first.success);
        const e = first.failure;
        if (e._tag !== "ContextOverflow") return yield* toFailed(e);
        // Force-compact with keepUserTurns=1 (aggressive) and re-sample once.
        // compactNow records compaction.performed and returns the compacted
        // list; persist it into `messages` so later iterations stay compacted.
        const compacted = yield* compactNow(messages, historyEvents, 1);
        messages = compacted;
        const resampled = yield* sample(deps, sessionId, {
          ...baseReq,
          messages: compacted,
        }).pipe(Effect.result);
        if (Result.isFailure(resampled)) {
          return yield* toFailed(resampled.failure);
        }
        return toOk(resampled.success);
      });

      if ("failed" in outcome) {
        return outcome.failed;
      }
      const result = outcome.ok;

      turnUsage = addUsage(turnUsage, result.usage);
      finalText = result.text;
      stopReason = result.stopReason;

      // Abort raised mid-stream.
      if (aborted()) {
        yield* append({
          type: "turn.aborted",
          data: { reason: "signal" },
        });
        return { stopReason: "abort", usage: turnUsage, text: finalText };
      }

      // Record the assistant message (text + tool_call parts) with usage.
      const parts: Part[] = [];
      if (result.text.length > 0) {
        parts.push({ type: "text", text: result.text });
      }
      for (const tc of result.toolCalls) {
        parts.push({
          type: "tool_call",
          id: tc.id,
          name: tc.name,
          input: parseInput(tc.arguments),
        });
      }
      yield* append({
        type: "assistant.message",
        data: { parts, usage: result.usage },
      });

      for (const tc of result.toolCalls) {
        yield* append({
          type: "tool.call.requested",
          data: {
            callId: tc.id,
            name: tc.name,
            input: parseInput(tc.arguments),
          },
        });
      }

      // No tool calls → the turn is done.
      if (result.toolCalls.length === 0) {
        yield* finishTurn(stopReason);
        return { stopReason, usage: turnUsage, text: finalText };
      }

      // Length/max_tokens with tool calls → response is untrustworthy; fail the
      // whole batch with synthetic errors and let the model retry (pi-style).
      if (result.stopReason === "length") {
        for (const tc of result.toolCalls) {
          yield* append({
            type: "tool.result",
            data: {
              callId: tc.id,
              content:
                "Tool not executed: the model response was truncated (length limit). Please retry the tool call.",
              isError: true,
              durationMs: 0,
            },
          });
        }
        continue;
      }

      // Execute the batch through the tool pipeline (authorize/schedule/execute).
      const batch: ToolCallRequest[] = result.toolCalls.map((tc) => ({
        callId: tc.id,
        name: tc.name,
        input: parseInput(tc.arguments),
      }));

      const results = yield* deps.tools.run(batch, {
        sessionId,
        workspace: deps.workspace,
        mode,
        ...(deps.signal ? { signal: deps.signal } : {}),
        ask: (req) => deps.approvals.ask(sessionId, req, deps.signal),
        emitProgress: (callId, message) =>
          deps.emitLive?.({
            type: "tool.progress",
            ts: Date.now(),
            sessionId,
            data: { callId, ...(message !== undefined ? { message } : {}) },
          }),
      });

      // Abort raised while the batch was executing (typically while parked on
      // an approval). The gateway releases the parking with a reject outcome
      // and tools.run returns; terminate the turn here rather than feeding
      // reject results back to the model.
      if (aborted()) {
        yield* append({
          type: "turn.aborted",
          data: { reason: "signal" },
        });
        return { stopReason: "abort", usage: turnUsage, text: finalText };
      }

      for (const r of results) {
        yield* append({
          type: "tool.result",
          data: {
            callId: r.callId,
            content: r.content,
            isError: r.isError,
            durationMs: r.durationMs,
          },
        });
      }
      // loop continues with the tool results in context
    }

    // Safety cap hit.
    yield* finishTurn(stopReason);
    return { stopReason, usage: turnUsage, text: finalText };
  });
}
