// The agent channel strip: a persistent per-agent status stack under the
// transcript (main + subagents, one row each, with badges) that turns into a
// selectable list while the selector is active. Pure rendering — app.ts owns
// the selector state and key routing.

import type { Color, StyledLine } from "@niuma/tuikit";
import { truncateToWidth } from "@niuma/tuikit";

export interface AgentStripEntry {
  /** "main" or a child sessionId. */
  readonly id: string;
  readonly label: string;
  readonly status: "main" | "running" | "done" | "failed";
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly durationMs: number | null;
}

/** Colors the strip needs. Decoupled from the product `Theme`. */
export interface AgentStripColors {
  readonly text: Color;
  readonly muted: Color;
  readonly accent: Color;
  readonly border: Color;
}

const statusGlyph = (status: AgentStripEntry["status"]): string =>
  status === "main"
    ? ""
    : status === "running"
    ? "◌"
    : status === "done"
    ? "●"
    : "◍";

const formatDuration = (ms: number | null): string =>
  ms === null || ms <= 0 ? "" : `${(ms / 1000).toFixed(0)}s`;

// Labels (a name chosen by the parent model, or a prompt fallback on legacy
// journals) are capped so one chatty spawn cannot eat the whole row.
const MAX_LABEL_WIDTH = 48;

const entryText = (entry: AgentStripEntry): string => {
  const usage = entry.tokensIn !== null && entry.tokensOut !== null
    ? `${entry.tokensIn}/${entry.tokensOut}tok`
    : "";
  const glyph = statusGlyph(entry.status);
  const label = truncateToWidth(entry.label, MAX_LABEL_WIDTH, true);
  return [glyph, label, usage, formatDuration(entry.durationMs)]
    .filter((part) => part.length > 0)
    .join(" ");
};

export const moveAgentSelection = (
  selected: number,
  count: number,
  delta: 1 | -1,
): number => count <= 0 ? 0 : (selected + delta + count) % count;

export const renderAgentStrip = (
  entries: readonly AgentStripEntry[],
  active: boolean,
  selected: number,
  width: number,
  colors: AgentStripColors,
): StyledLine[] => {
  if (entries.length === 0) return [];
  const row = (text: string, fg: Color): StyledLine => {
    const clipped = truncateToWidth(text, Math.max(1, width - 1));
    return { spans: [{ text: clipped, style: { fg } }] };
  };
  // One row per entry, active or not — the agent list is a stack, never a
  // single crammed line. `active` only adds the marker + highlight.
  return entries.map((entry, index) =>
    row(
      `${active && index === selected ? "▶" : " "} ${entryText(entry)}`,
      active && index === selected ? colors.accent : colors.text,
    )
  );
};
