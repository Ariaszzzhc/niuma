import { Effect, Stream } from "effect";
import type { RecordedEvent } from "@niuma/schema";
import type {
  ChatRequest,
  Message as ProviderMessage,
  ProviderAdapter,
  ProviderError,
} from "@niuma/provider";

const MUTATING = new Set(["write", "edit", "apply_patch"]);
const READING = new Set(["read", "grep", "glob"]);

// Adapted verbatim from codex prompts/templates/compact/prompt.md. Sent as the
// final user message of the summarization call; instructs the model to write a
// handoff summary for the next LLM that will resume from the compacted state.
export const SUMMARIZATION_PROMPT: string =
  `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

// Adapted verbatim from codex prompts/templates/compact/summary_prefix.md.
// Prepended to the summary body (both LLM and template modes) so the bridge
// message is recognisable by isSummaryMessage regardless of how the body was
// produced — matches codex's single-marker design.
export const SUMMARY_PREFIX: string =
  `Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:`;

// Marker for prior compaction bridge messages so callers can recognise them.
// A bridge message is always SUMMARY_PREFIX + "\n" + body.
export const isSummaryMessage = (text: string): boolean =>
  text.startsWith(`${SUMMARY_PREFIX}\n`);

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? v as Record<string, unknown> : {};

const pathOf = (input: unknown): string | undefined => {
  const r = asRecord(input);
  const p = r.path ?? r.file_path ?? r.filePath ?? r.pattern;
  return typeof p === "string" ? p : undefined;
};

// v0 template summary: files touched (from tool.call.requested), notable bash
// commands, and the last known plan/TODO state (from update_plan calls).
export function buildSummary(events: ReadonlyArray<RecordedEvent>): string {
  const wrote = new Set<string>();
  const read = new Set<string>();
  const bash: string[] = [];
  let lastPlan: string | undefined;

  for (const ev of events) {
    if (ev.type !== "tool.call.requested") continue;
    const { name, input } = ev.data;
    if (MUTATING.has(name)) {
      const p = pathOf(input);
      if (p) wrote.add(p);
    } else if (READING.has(name)) {
      const p = pathOf(input);
      if (p) read.add(p);
    } else if (name === "bash") {
      const cmd = asRecord(input).command;
      if (typeof cmd === "string") bash.push(cmd);
    } else if (name === "update_plan") {
      lastPlan = JSON.stringify(asRecord(input).plan ?? input);
    }
  }

  const lines: string[] = [
    "[Conversation summary — earlier history was compacted to save context.]",
  ];
  if (wrote.size > 0) {
    lines.push(`Files created/modified: ${[...wrote].join(", ")}`);
  }
  if (read.size > 0) {
    lines.push(`Files read/searched: ${[...read].slice(0, 20).join(", ")}`);
  }
  if (bash.length > 0) {
    lines.push(
      `Commands run (${bash.length}): ${bash.slice(-8).join(" ; ")}`,
    );
  }
  if (lastPlan) lines.push(`Current plan/TODO: ${lastPlan}`);
  lines.push(
    "Continue the task using the recent messages below and this summary.",
  );
  return lines.join("\n");
}

// Replace every message before the start of the last `keepUserTurns` user
// turns with one user-role summary message. Tool messages orphaned from their
// assistant tool_calls are dropped along with the prefix, keeping the request
// well-formed.
export function compactMessages(
  messages: ReadonlyArray<ProviderMessage>,
  summaryText: string,
  keepUserTurns = 2,
): ProviderMessage[] {
  const userIdx: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === "user") userIdx.push(i);
  });
  if (userIdx.length <= keepUserTurns) return [...messages];

  const cut = userIdx[userIdx.length - keepUserTurns];
  const summary: ProviderMessage = { role: "user", content: summaryText };
  return [summary, ...messages.slice(cut)];
}

export interface SummarizeDeps {
  readonly provider: ProviderAdapter;
  readonly model: string;
  readonly signal?: AbortSignal;
}

// Ask the model to write the handoff summary. The summarization request is a
// dedicated, tool-free, system-free provider call whose message list is the
// FULL current conversation plus one final user message (the prompt above).
// Returns the raw model text, or null when the stream yielded no text. Errors
// propagate — the caller falls back to the template (compactNow in loop.ts).
// Sampled WITHOUT the sample() retry wrapper (one shot; transport withRetry
// still applies to the initial fetch) so worst-case latency stays bounded.
export function summarizeHistory(
  deps: SummarizeDeps,
  messages: ReadonlyArray<ProviderMessage>,
): Effect.Effect<string | null, ProviderError> {
  const req: ChatRequest = {
    model: deps.model,
    messages: [...messages, { role: "user", content: SUMMARIZATION_PROMPT }],
    tools: [],
    ...(deps.signal ? { abort: deps.signal } : {}),
  };
  return Effect.gen(function* () {
    let text = "";
    yield* deps.provider.stream(req).pipe(
      Stream.runForEach((ev) =>
        Effect.sync(() => {
          if (ev._tag === "TextDelta") text += ev.text;
        })
      ),
    );
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
  });
}
