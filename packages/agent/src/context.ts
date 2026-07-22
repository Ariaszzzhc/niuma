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

// Replay the event log into the provider message list the model consumes.
// user.message / assistant.message / tool.result map 1:1; everything else
// (turn markers, approvals, compaction, errors) is orchestration metadata.
export function eventsToMessages(
  events: ReadonlyArray<RecordedEvent>,
): ProviderMessage[] {
  const messages: ProviderMessage[] = [];
  for (const ev of events) {
    switch (ev.type) {
      case "user.message": {
        messages.push({ role: "user", content: textOfParts(ev.data.parts) });
        break;
      }
      case "assistant.message": {
        const calls = toolCallsOfParts(ev.data.parts);
        const base: ProviderMessage = {
          role: "assistant",
          content: textOfParts(ev.data.parts),
        };
        messages.push(calls.length > 0 ? { ...base, toolCalls: calls } : base);
        break;
      }
      case "tool.result": {
        messages.push({
          role: "tool",
          content: resultContentToString(ev.data.content),
          toolCallId: ev.data.callId,
        });
        break;
      }
      default:
        break;
    }
  }
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
