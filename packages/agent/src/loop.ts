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
import { recordModelCall } from "./model_call.ts";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const COMPACT_RATIO = 0.85;
const MAX_ITERATIONS = 100;

// ============================================================================
// Incremental projection (replay once per turn)
//
// Message-relevant recorded events are exactly user.message | assistant.message
// | tool.result (context.ts eventsToMessages / projectEvent; every other type
// hits `default`). Within a single runTurn invocation, every such event is
// appended by this loop itself, synchronously in its own fiber:
//   - user.message: claimed from the Server Input Coordinator and appended at
//     the loop top immediately before the next provider request;
//   - assistant.message / tool.result: appended after sampling / running tools.
// No external writer appends message-relevant events to an in-flight turn —
// admission remains in Server memory until `TurnInput.claim` durably appends
// it. Therefore the log is replayed ONCE per turn and the message list is
// maintained incrementally by mirroring each claimed/appended event. This
// drops the per-iteration replay — O(n²) over a growing JSONL — to one O(n)
// replay plus O(1) per-iteration appends. historyEvents is mirrored at the same
// append sites so buildSummary (which scans tool.call.requested) sees the same
// input a fresh replay would yield.
// ============================================================================

export interface TurnResult {
  readonly stopReason: StopReason;
  readonly usage: Usage;
  readonly text: string;
  // Present only when the turn terminated on a provider/stream error
  // (stopReason === "error"). Carries the human-readable terminal message.
  readonly error?: string;
}

const zeroUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
});

const addTokenCount = (
  a: number | null | undefined,
  b: number | null | undefined,
): number | null =>
  a === null || a === undefined || b === null || b === undefined ? null : a + b;
const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: addTokenCount(a.inputTokens, b.inputTokens),
  outputTokens: addTokenCount(a.outputTokens, b.outputTokens),
  reasoningTokens: addTokenCount(a.reasoningTokens, b.reasoningTokens),
  cachedInputTokens: addTokenCount(a.cachedInputTokens, b.cachedInputTokens),
  cacheWriteTokens: addTokenCount(a.cacheWriteTokens, b.cacheWriteTokens),
});

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
  // Thinking blocks in arrival order. A block closes when a delta carrying
  // `encrypted` lands (credential marks block end) or when a TextDelta /
  // ToolCall interrupts the thinking run; a block that already carries
  // `encrypted` never merges with later deltas (kimi mergeInPlace rule).
  readonly thinking: ReadonlyArray<{
    readonly text: string;
    readonly encrypted?: string;
  }>;
  readonly toolCalls: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly arguments: string;
  }>;
  readonly stopReason: StopReason;
  readonly usage: Usage;
}

interface RawSampleResult extends Omit<SampleResult, "usage"> {
  readonly providerUsage?: ProviderUsage;
  readonly attempts: number;
}

// Human-readable rendering of a provider error for error.occurred / TurnResult.
// _tag always; plus `message`/`retryAfterMs` when the variant carries them.
// Never JSON.stringify the raw object — Network.cause is often a huge/opaque
// Error and dumping it pollutes the Session Journal.
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
    thinking: { text: string; encrypted?: string }[];
    toolCalls: SampleResult["toolCalls"][number][];
    stopReason: { v: StopReason };
    usage: { v: ProviderUsage | undefined };
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
          case "ThinkingDelta": {
            // Merge into the open block; a block carrying `encrypted` is
            // sealed, so a later delta starts a fresh one. An `encrypted`
            // credential closes the block it lands on.
            const open = acc.thinking[acc.thinking.length - 1];
            const block = open && open.encrypted === undefined ? open : (() => {
              const b: { text: string; encrypted?: string } = { text: "" };
              acc.thinking.push(b);
              return b;
            })();
            block.text += ev.text;
            if (ev.encrypted !== undefined) block.encrypted = ev.encrypted;
            acc.emittedAny.v = true;
            // Live stream carries text only; a pure-credential delta (empty
            // text) is persisted but not pushed (nothing new to render).
            if (ev.text.length > 0) {
              deps.emitLive?.({
                type: "thinking.delta",
                ts: Date.now(),
                sessionId,
                data: { delta: ev.text },
              });
            }
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
            acc.usage.v = ev.usage;
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
const sampleRaw = (
  deps: RunTurnDeps,
  sessionId: string,
  req: ChatRequest,
  attemptCount: { v: number },
  onRetry?: (attempt: number, e: ProviderError) => Effect.Effect<void>,
): Effect.Effect<RawSampleResult, ProviderError> =>
  Effect.gen(function* () {
    const aborted = () => deps.signal?.aborted ?? false;
    let attempt = 0;
    // Sticky: once any attempt emitted partial text, every subsequent retry
    // resets the live buffer first (a prior attempt may have populated it).
    let hadPartialStream = false;

    while (true) {
      attemptCount.v = attempt + 1;
      // Per-attempt locals — discarded on retry so nothing partial commits.
      const acc = {
        text: "",
        thinking: [] as { text: string; encrypted?: string }[],
        toolCalls: [] as SampleResult["toolCalls"][number][],
        stopReason: { v: "stop" as StopReason },
        usage: { v: undefined as ProviderUsage | undefined },
        emittedAny: { v: false },
      };

      const outcome = yield* runStreamOnce(deps, sessionId, req, acc).pipe(
        Effect.result,
      );

      if (Result.isSuccess(outcome)) {
        return {
          text: acc.text,
          thinking: acc.thinking,
          toolCalls: acc.toolCalls,
          stopReason: acc.stopReason.v,
          ...(acc.usage.v !== undefined ? { providerUsage: acc.usage.v } : {}),
          attempts: attempt + 1,
        };
      }
      const e = outcome.failure;

      // Abort raised mid-stream: record nothing, surface abort (no retry).
      if (aborted()) {
        return {
          text: "",
          thinking: [],
          toolCalls: [],
          stopReason: "abort",
          attempts: attempt + 1,
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
      yield* deps.journal.append(sessionId, {
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

const sample = (
  deps: RunTurnDeps,
  sessionId: string,
  turnId: string,
  req: ChatRequest,
): Effect.Effect<SampleResult, ProviderError> => {
  const attemptCount = { v: 1 };
  return recordModelCall(
    {
      journal: deps.journal,
      sessionId,
      turnId,
      purpose: "agent",
      actor: deps.actor ?? "main",
      providerId: deps.providerId ?? "unknown",
      modelId: deps.model,
      billingMode: deps.billingMode ?? "unknown",
    },
    sampleRaw(deps, sessionId, req, attemptCount).pipe(
      Effect.map((value) => ({
        value,
        usage: value.providerUsage,
        finishReason: value.stopReason,
        attempts: value.attempts,
      })),
    ),
    {
      attempts: () => attemptCount.v,
      errorMessage,
    },
  ).pipe(
    Effect.map(({ value, usage }) => ({
      text: value.text,
      thinking: value.thinking,
      toolCalls: value.toolCalls,
      stopReason: value.stopReason,
      usage,
    })),
  );
};

export function runTurn(
  sessionId: string,
  deps: RunTurnDeps,
): Effect.Effect<TurnResult> {
  const mode: ToolMode = deps.mode ?? "full";
  const contextWindow = deps.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const threshold = Math.floor(contextWindow * COMPACT_RATIO);
  const aborted = () => deps.signal?.aborted ?? false;
  const turnId = deps.turnId ?? crypto.randomUUID();

  return Effect.gen(function* () {
    const system = yield* Effect.promise(() =>
      buildSystemPrompt(deps.workspace, undefined, deps.skills)
    );
    const tools = deps.tools.defs(mode);

    let turnUsage = zeroUsage();
    let finalText = "";
    let stopReason: StopReason = "stop";

    // D: replay ONCE per turn, then maintain `messages`/`historyEvents` locally
    // (see header invariant). Within a turn only this loop appends message-
    // relevant events, so the local mirror stays an exact projection.
    const replayed = yield* deps.journal.replay(sessionId);
    const historyEvents: RecordedEvent[] = [...replayed];
    // keepThinking gates reasoningContent projection (context.ts); driven by
    // the same ThinkingConfig that goes on the wire.
    const projectOptions = {
      ...(deps.thinking?.keep !== undefined
        ? { keepThinking: deps.thinking.keep }
        : {}),
    };
    let messages: ProviderMessage[] = eventsToMessages(
      historyEvents,
      projectOptions,
    );

    // Append + mirror: every event the loop records is folded into the local
    // projection so neither `messages` nor `historyEvents` need re-deriving
    // from a fresh replay. Metadata events (turn.*, error.*, approval.*,
    // tool.call.requested) are pushed into historyEvents (keeping
    // buildSummary's view identical to a replay) and no-op'd for messages by
    // projectEvent; compaction.performed is the exception — its mirror folds
    // `messages` down to the bridge, but compactNow computes the compacted
    // list before appending and the caller reassigns `messages` to it, so
    // the fold is never observed here.
    const append = (input: EventInput): Effect.Effect<RecordedEvent> =>
      Effect.gen(function* () {
        const ev = yield* deps.journal.append(sessionId, input);
        historyEvents.push(ev);
        projectEvent(messages, ev, projectOptions);
        return ev;
      });

    // Inputs claimed through the server-owned admission seam have already
    // been appended durably. Fold them into the same local mirrors as events
    // appended by this loop, without writing them a second time.
    const mirrorRecorded = (event: RecordedEvent): void => {
      historyEvents.push(event);
      projectEvent(messages, event, projectOptions);
    };

    // Compact `messages`, preferring an LLM-written handoff summary
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
            journal: deps.journal,
            sessionId,
            turnId,
            provider: deps.provider,
            ...(deps.providerId !== undefined
              ? { providerId: deps.providerId }
              : {}),
            model: deps.model,
            ...(deps.billingMode !== undefined
              ? { billingMode: deps.billingMode }
              : {}),
            ...(deps.actor !== undefined ? { actor: deps.actor } : {}),
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
        // Compute the compacted list BEFORE appending: projectEvent folds a
        // summary-bearing compaction.performed into the mirrored `messages`
        // (splicing it down to the bridge), which would otherwise destroy
        // the tail compactMessages keeps. The event stores the bare body —
        // the context fold re-wraps it with SUMMARY_PREFIX on replay.
        const compacted = compactMessages(msgs, summaryText, keepUserTurns);
        yield* append({
          type: "compaction.performed",
          data: { summaryMessageId: summaryId, mode, summary: body },
        });
        return compacted;
      });

    yield* append({ type: "turn.started", data: { turnId } });

    const finishTurn = (reason: StopReason): Effect.Effect<RecordedEvent> =>
      append({
        type: "turn.completed",
        data: { turnId, stopReason: reason },
      });

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      if (aborted()) {
        yield* append({
          type: "turn.aborted",
          data: { turnId, reason: "signal" },
        });
        return { stopReason: "abort", usage: turnUsage, text: finalText };
      }

      // Atomically claim + record every input currently bound to this Turn.
      // Initial `started` input and later `steered` input share this path.
      // Anything still pending when explicit interrupt wins is returned to
      // the client and can never appear in this claimed list.
      const claimed = deps.input ? yield* deps.input.claim() : [];
      for (const event of claimed) mirrorRecorded(event);

      // Interrupt may have won immediately after the loop-top check but
      // before claim entered the coordinator. Do not sample stale context.
      if (aborted()) {
        yield* append({
          type: "turn.aborted",
          data: { turnId, reason: "signal" },
        });
        return { stopReason: "abort", usage: turnUsage, text: finalText };
      }

      // Pre-sampling token check → compact older history if over threshold.
      // Because `messages` persists across iterations, a compacted list stays
      // compacted and the check does not append duplicate compaction events
      // while the conversation remains over threshold.
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
        ...(deps.thinking !== undefined ? { thinking: deps.thinking } : {}),
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
            data: { turnId, stopReason: "error" },
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
        const first = yield* sample(deps, sessionId, turnId, baseReq).pipe(
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
        const resampled = yield* sample(deps, sessionId, turnId, {
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
          data: { turnId, reason: "signal" },
        });
        return { stopReason: "abort", usage: turnUsage, text: finalText };
      }

      // Record the assistant message (thinking + text + tool_call parts) with
      // usage. Thinking blocks go first, in arrival order; a block with
      // `encrypted` keeps the credential for future credential-aware convert
      // layers (niuma only stores/forwards it opaquely).
      const parts: Part[] = [];
      for (const t of result.thinking) {
        parts.push({
          type: "thinking",
          text: t.text,
          ...(t.encrypted !== undefined ? { encrypted: t.encrypted } : {}),
        });
      }
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
        data: { parts },
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
        const close = deps.input
          ? yield* deps.input.tryClose()
          : ("close" as const);
        if (close === "continue") {
          // A steer admission beat closing; consume it in the next iteration.
          continue;
        }
        if (close === "interrupted" || aborted()) {
          yield* append({
            type: "turn.aborted",
            data: { turnId, reason: "signal" },
          });
          return { stopReason: "abort", usage: turnUsage, text: finalText };
        }
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
          data: { turnId, reason: "signal" },
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

    // Safety cap hit. A late pending steer cannot be silently completed:
    // surface a terminal failure so the SessionManager returns it as a draft.
    const close = deps.input
      ? yield* deps.input.tryClose()
      : ("close" as const);
    if (close === "interrupted" || aborted()) {
      yield* append({
        type: "turn.aborted",
        data: { turnId, reason: "signal" },
      });
      return { stopReason: "abort", usage: turnUsage, text: finalText };
    }
    if (close === "continue") {
      const message = "turn reached the maximum iteration count";
      yield* append({
        type: "error.occurred",
        data: { message, retryable: false },
      });
      yield* finishTurn("error");
      return {
        stopReason: "error",
        usage: turnUsage,
        text: finalText,
        error: message,
      };
    }
    yield* finishTurn(stopReason);
    return { stopReason, usage: turnUsage, text: finalText };
  });
}
