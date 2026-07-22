import { Effect, Stream } from "effect";
import type { Part, StopReason, Usage } from "@niuma/schema";
import type {
  ChatRequest,
  Message as ProviderMessage,
  ProviderError,
  StreamEvent as ProviderStreamEvent,
  Usage as ProviderUsage,
} from "@niuma/provider";
import type { RunTurnDeps, ToolCallRequest, ToolMode } from "./deps.ts";
import { buildSystemPrompt } from "./prompt.ts";
import {
  eventsToMessages,
  estimateRequestTokens,
} from "./context.ts";
import { buildSummary, compactMessages } from "./compaction.ts";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const COMPACT_RATIO = 0.85;
const MAX_ITERATIONS = 100;

export interface TurnResult {
  readonly stopReason: StopReason;
  readonly usage: Usage;
  readonly text: string;
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
    ? { inputTokens: u.promptTokens ?? 0, outputTokens: u.completionTokens ?? 0 }
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

// Runs one provider stream to completion, accumulating text (emitted live as
// text.delta) and complete tool calls. The provider adapter already coalesces
// tool-call deltas, so calls arrive whole.
const sample = (
  deps: RunTurnDeps,
  sessionId: string,
  req: ChatRequest,
): Effect.Effect<SampleResult, ProviderError> =>
  Effect.gen(function* () {
    let text = "";
    const toolCalls: SampleResult["toolCalls"][number][] = [];
    let stopReason: StopReason = "stop";
    let usage: Usage = zeroUsage();

    yield* deps.provider.stream(req).pipe(
      Stream.runForEach((ev: ProviderStreamEvent) =>
        Effect.sync(() => {
          switch (ev._tag) {
            case "TextDelta": {
              text += ev.text;
              deps.emitLive?.({
                type: "text.delta",
                ts: Date.now(),
                sessionId,
                data: { delta: ev.text },
              });
              break;
            }
            case "ToolCall": {
              toolCalls.push({
                id: ev.id,
                name: ev.name,
                arguments: ev.arguments,
              });
              break;
            }
            case "Finish": {
              stopReason = ev.reason;
              usage = mapUsage(ev.usage);
              break;
            }
          }
        })
      ),
    );

    return { text, toolCalls, stopReason, usage };
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

    yield* deps.eventLog.append(sessionId, {
      type: "turn.started",
      data: {},
    });

    let turnUsage = zeroUsage();
    let finalText = "";
    let stopReason: StopReason = "stop";

    const finishTurn = (reason: StopReason) =>
      deps.eventLog.append(sessionId, {
        type: "turn.completed",
        data: { stopReason: reason, usage: turnUsage },
      });

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      if (aborted()) {
        yield* deps.eventLog.append(sessionId, {
          type: "turn.aborted",
          data: { reason: "signal" },
        });
        return { stopReason: "abort", usage: turnUsage, text: finalText };
      }

      // Drain steer queue → append as user messages before sampling.
      const steered = deps.drainInput?.() ?? [];
      for (const parts of steered) {
        if (parts.length === 0) continue;
        yield* deps.eventLog.append(sessionId, {
          type: "user.message",
          data: { parts },
        });
      }

      const events = yield* deps.eventLog.replay(sessionId);
      let messages: ProviderMessage[] = eventsToMessages(events);

      // Pre-sampling token check → compact older history if over threshold.
      let estimate = estimateRequestTokens(system, messages, tools);
      if (estimate > threshold) {
        const summaryId = crypto.randomUUID();
        messages = compactMessages(messages, buildSummary(events));
        yield* deps.eventLog.append(sessionId, {
          type: "compaction.performed",
          data: { summaryMessageId: summaryId },
        });
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

      // Sample; on ContextOverflow force a compaction and retry once.
      const result = yield* sample(deps, sessionId, baseReq).pipe(
        Effect.catchTag("ContextOverflow", () =>
          Effect.gen(function* () {
            const summaryId = crypto.randomUUID();
            const compacted = compactMessages(
              messages,
              buildSummary(events),
              1,
            );
            yield* deps.eventLog.append(sessionId, {
              type: "compaction.performed",
              data: { summaryMessageId: summaryId },
            });
            return yield* sample(deps, sessionId, {
              ...baseReq,
              messages: compacted,
            });
          })),
        Effect.catchIf(
          (_e): _e is ProviderError => true,
          (e: ProviderError) =>
            Effect.gen(function* () {
              yield* deps.eventLog.append(sessionId, {
                type: "error.occurred",
                data: {
                  message: `${e._tag}: ${JSON.stringify(e)}`,
                  retryable: false,
                },
              });
              return {
                text: "",
                toolCalls: [] as SampleResult["toolCalls"],
                stopReason: aborted() ? "abort" : "stop",
                usage: zeroUsage(),
              } satisfies SampleResult;
            }),
        ),
      );

      turnUsage = addUsage(turnUsage, result.usage);
      finalText = result.text;
      stopReason = result.stopReason;

      // Abort raised mid-stream.
      if (aborted()) {
        yield* deps.eventLog.append(sessionId, {
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
      yield* deps.eventLog.append(sessionId, {
        type: "assistant.message",
        data: { parts, usage: result.usage },
      });

      for (const tc of result.toolCalls) {
        yield* deps.eventLog.append(sessionId, {
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
          yield* deps.eventLog.append(sessionId, {
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
        yield* deps.eventLog.append(sessionId, {
          type: "turn.aborted",
          data: { reason: "signal" },
        });
        return { stopReason: "abort", usage: turnUsage, text: finalText };
      }

      for (const r of results) {
        yield* deps.eventLog.append(sessionId, {
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
