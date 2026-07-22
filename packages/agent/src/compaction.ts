import type { RecordedEvent } from "@niuma/schema";
import type { Message as ProviderMessage } from "@niuma/provider";

const MUTATING = new Set(["write", "edit", "apply_patch"]);
const READING = new Set(["read", "grep", "glob"]);

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
