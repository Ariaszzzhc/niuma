import type {
  Part,
  RecordedEvent,
  ToolResultContent,
} from "@niuma/schema";
import type {
  Message as ProviderMessage,
  ToolCall as ProviderToolCall,
  ToolDef as ProviderToolDef,
} from "@niuma/provider";

const CHARS_PER_TOKEN = 4;

export const estimateTokens = (text: string): number =>
  Math.ceil(text.length / CHARS_PER_TOKEN);

const textOfParts = (parts: ReadonlyArray<Part>): string =>
  parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");

const toolCallsOfParts = (
  parts: ReadonlyArray<Part>,
): ProviderToolCall[] =>
  parts
    .filter((p): p is Extract<Part, { type: "tool_call" }> =>
      p.type === "tool_call"
    )
    .map((p) => ({
      id: p.id,
      name: p.name,
      arguments: typeof p.input === "string"
        ? p.input
        : JSON.stringify(p.input ?? {}),
    }));

export const resultContentToString = (content: ToolResultContent): string =>
  typeof content === "string"
    ? content
    : content.map((b) => b.text).join("\n");

// Text used for the synthetic tool message that closes a tool_call whose
// result never landed (turn interrupted, approval left pending, process crash
// between the assistant message and the tool batch). Codex uses the same
// one-word convention for its synthetic FunctionCallOutput on interrupted
// calls (context_manager/normalize.rs).
export const ABORTED_TOOL_OUTPUT = "aborted";

// Append the provider-message projection of a single event (when message-
// relevant) onto `out`. Shared by eventsToMessages (full replay) and the agent
// loop's incremental mirror (Fix D: replay once per turn, then maintain the
// message list by mirroring each appended event). Metadata event types
// (turn/approval/compaction/error/tool.call.requested) hit `default` and are
// no-ops here — they carry no provider message.
//
// Synthetic-pairing contract (mirrors codex's context_manager/normalize.rs):
// an assistant tool_call whose tool.result never arrives gets a synthetic
// `aborted` tool message as soon as the turn boundary is crossed, and a
// tool.result whose call was dropped lands only if some pending call is still
// waiting. This keeps the projected list API-legal: OpenAI rejects any
// assistant message with tool_calls that isn't followed by a tool message
// per call, and any tool message without a matching call. Without this, a
// turn that died mid-batch (interrupt, pending approval, crash) poisons every
// subsequent turn with an HTTP 400. The event log is untouched — pairing is
// a view concern, not a history rewrite.
export const projectEvent = (
  out: ProviderMessage[],
  ev: RecordedEvent,
): void => {
  switch (ev.type) {
    case "user.message": {
      closePendingToolCalls(out);
      out.push({ role: "user", content: textOfParts(ev.data.parts) });
      break;
    }
    case "assistant.message": {
      closePendingToolCalls(out);
      const calls = toolCallsOfParts(ev.data.parts);
      const base: ProviderMessage = {
        role: "assistant",
        content: textOfParts(ev.data.parts),
      };
      out.push(calls.length > 0 ? { ...base, toolCalls: calls } : base);
      break;
    }
    case "tool.result": {
      const idx = findPendingCall(out, ev.data.callId);
      if (idx === -1) {
        // No pending call with this id. Either the call was never projected
        // (compaction cut it) or it was already closed as aborted — i.e. the
        // result arrived after the turn boundary. Codex drops orphan outputs
        // outright; we can do better when another call is still pending: the
        // model emitted exactly one result per call, so a late result belongs
        // to the batch's remaining open call.
        const pending = firstPendingCall(out);
        if (pending !== -1) {
          const targetId = toolCallIdAt(out, pending);
          if (targetId !== undefined) {
            insertAfterZone(out, pending, {
              role: "tool",
              content: resultContentToString(ev.data.content),
              toolCallId: targetId,
            });
          }
        }
        break;
      }
      insertAfterZone(out, idx, {
        role: "tool",
        content: resultContentToString(ev.data.content),
        toolCallId: ev.data.callId,
      });
      break;
    }
    default:
      break;
  }
};

// Append `msg` at the end of the tool-message zone directly following the
// assistant message at `idx` (i.e. after any tool messages already paired to
// that assistant, before the next non-tool message). Keeps results in arrival
// order instead of stacking them LIFO behind the assistant.
const insertAfterZone = (
  out: ProviderMessage[],
  assistantIdx: number,
  msg: ProviderMessage,
): void => {
  let j = assistantIdx + 1;
  while (j < out.length && out[j]!.role === "tool") j++;
  out.splice(j, 0, msg);
};

// Index of the assistant message carrying a tool_call with `callId` that has
// no matching tool message yet, or -1. An answer counts only when the tool
// message sits between its assistant message and the next non-tool message
// (the well-formed zone); a stray result elsewhere doesn't close the call.
const findPendingCall = (
  out: ReadonlyArray<ProviderMessage>,
  callId: string,
): number => {
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.role !== "assistant" || !m.toolCalls) continue;
    if (!m.toolCalls.some((c) => c.id === callId)) continue;
    const answered = new Set<string>();
    for (let j = i + 1; j < out.length; j++) {
      const t = out[j]!;
      if (t.role !== "tool") break;
      if (t.toolCallId) answered.add(t.toolCallId);
    }
    return answered.has(callId) ? -1 : i;
  }
  return -1;
};

// Index of the earliest assistant message with at least one unanswered
// tool_call, or -1. Used to home a late result whose own call is gone.
const firstPendingCall = (out: ReadonlyArray<ProviderMessage>): number => {
  for (let i = 0; i < out.length; i++) {
    const m = out[i]!;
    if (m.role !== "assistant" || !m.toolCalls) continue;
    const answered = new Set<string>();
    for (let j = i + 1; j < out.length; j++) {
      const t = out[j]!;
      if (t.role !== "tool") break;
      if (t.toolCallId) answered.add(t.toolCallId);
    }
    if (m.toolCalls.some((c) => !answered.has(c.id))) return i;
  }
  return -1;
};

const toolCallIdAt = (
  out: ReadonlyArray<ProviderMessage>,
  assistantIdx: number,
): string | undefined => {
  const m = out[assistantIdx]!;
  const answered = new Set<string>();
  for (let i = assistantIdx + 1; i < out.length; i++) {
    const t = out[i]!;
    if (t.role !== "tool") break;
    if (t.toolCallId) answered.add(t.toolCallId);
  }
  return m.toolCalls?.find((c) => !answered.has(c.id))?.id;
};

// Close every unanswered tool_call in `out` with a synthetic `aborted` tool
// message, appended at the end of its assistant's tool zone. Called before
// projecting a new user/assistant message — i.e. at the point where the loop
// can no longer produce the missing result.
const closePendingToolCalls = (out: ProviderMessage[]): void => {
  for (let i = 0; i < out.length; i++) {
    const m = out[i]!;
    if (m.role !== "assistant" || !m.toolCalls) continue;
    const answered = new Set<string>();
    for (let j = i + 1; j < out.length; j++) {
      const t = out[j]!;
      if (t.role !== "tool") break;
      if (t.toolCallId) answered.add(t.toolCallId);
    }
    const missing = m.toolCalls.filter((c) => !answered.has(c.id));
    if (missing.length === 0) continue;
    const synthetics: ProviderMessage[] = missing.map((c) => ({
      role: "tool",
      content: ABORTED_TOOL_OUTPUT,
      toolCallId: c.id,
    }));
    let j = i + 1;
    while (j < out.length && out[j]!.role === "tool") j++;
    out.splice(j, 0, ...synthetics);
    i = j + synthetics.length - 1;
  }
};

// Replay the event log into the provider message list the model consumes.
// user.message / assistant.message / tool.result map 1:1; everything else
// (turn markers, approvals, compaction, errors) is orchestration metadata.
// A turn's final tool batch may be left unanswered by an interrupt — flush
// those too (see projectEvent's pairing contract).
export function eventsToMessages(
  events: ReadonlyArray<RecordedEvent>,
): ProviderMessage[] {
  const messages: ProviderMessage[] = [];
  for (const ev of events) projectEvent(messages, ev);
  closePendingToolCalls(messages);
  return messages;
}

const toolDefsChars = (tools: ReadonlyArray<ProviderToolDef>): number =>
  tools.reduce(
    (n, t) =>
      n + t.name.length + (t.description?.length ?? 0) +
      (t.parameters ? JSON.stringify(t.parameters).length : 0),
    0,
  );

const messageChars = (m: ProviderMessage): number => {
  let n = m.content.length + m.role.length;
  if (m.toolCalls) {
    for (const c of m.toolCalls) n += c.name.length + c.arguments.length;
  }
  return n;
};

// Whole-request token estimate: system + messages + tool schemas.
export function estimateRequestTokens(
  system: string,
  messages: ReadonlyArray<ProviderMessage>,
  tools: ReadonlyArray<ProviderToolDef>,
): number {
  const chars = system.length +
    messages.reduce((n, m) => n + messageChars(m), 0) +
    toolDefsChars(tools);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}
