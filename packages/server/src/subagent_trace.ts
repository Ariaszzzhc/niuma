// Builds the compact, model-visible execution trace a failed subagent's
// parent receives. Pure over a child journal's recorded events: chronological,
// per-item and total caps keep it from bloating the parent's context.

import type { RecordedEvent } from "@niuma/schema";

const MAX_EVENTS = 30;
const MAX_ITEM_CHARS = 2 * 1024;
const MAX_TOTAL_CHARS = 10 * 1024;

const truncate = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n)}…(+${s.length - n} chars)`;

const toolContentText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content);
  return content
    .filter((block): block is { type: "text"; text: string } =>
      block !== null && typeof block === "object" &&
      (block as { type?: unknown }).type === "text"
    )
    .map((block) => block.text)
    .join("");
};

export const buildSubagentTrace = (
  events: ReadonlyArray<RecordedEvent>,
): string => {
  const lines: string[] = [];
  // `total` counts each pushed line plus its join("\n") separator so the
  // joined trace can never exceed MAX_TOTAL_CHARS.
  let total = 0;
  const push = (line: string): void => {
    const remaining = MAX_TOTAL_CHARS - total;
    if (remaining <= 0) return;
    let out = line;
    if (out.length > remaining) {
      const marker = "…(truncated)";
      out = remaining > marker.length
        ? `${out.slice(0, remaining - marker.length)}${marker}`
        : out.slice(0, remaining);
    }
    lines.push(out);
    total += out.length + 1;
  };
  for (const event of events.slice(-MAX_EVENTS)) {
    if (total >= MAX_TOTAL_CHARS) break;
    switch (event.type) {
      case "assistant.message": {
        const text = event.data.parts
          .filter((part): part is Extract<typeof part, { type: "text" }> =>
            part.type === "text"
          )
          .map((part) => part.text)
          .join("");
        if (text.trim().length > 0) {
          push(`assistant: ${truncate(text, MAX_ITEM_CHARS)}`);
        }
        break;
      }
      case "tool.call.requested":
        push(
          `tool call: ${event.data.name} ${
            truncate(JSON.stringify(event.data.input), 400)
          }`,
        );
        break;
      case "tool.result":
        push(
          `tool result (${
            event.data.isError ? "error" : "ok"
          }, ${event.data.durationMs}ms): ${
            truncate(toolContentText(event.data.content), MAX_ITEM_CHARS)
          }`,
        );
        break;
      case "error.occurred":
        push(`error: ${event.data.message}`);
        break;
      default:
        break;
    }
  }
  return lines.join("\n");
};

export const lastCompletedUsage = (
  events: ReadonlyArray<RecordedEvent>,
): { inputTokens: number; outputTokens: number } | null => {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === "model.call.completed") {
      const { inputTokens, outputTokens } = event.data.usage;
      // Missing provider token counts stay missing — never fabricate zeroes.
      if (inputTokens === null || outputTokens === null) return null;
      return { inputTokens, outputTokens };
    }
  }
  return null;
};
