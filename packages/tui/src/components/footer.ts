// ===========================================================================
// @niuma/tui — two-line footer
// ---------------------------------------------------------------------------
// The footer follows Kimi Code's information hierarchy without copying its
// badges or copy: primary session context on row one, ambient metrics and
// contextual key hints on row two. Right-hand status is reserved first so a
// narrow terminal drops hints/path detail before activity/context.
// ===========================================================================

import {
  fitLine,
  lineWidth,
  stringWidth,
  type StyledLine,
  type StyledSpan,
} from "@niuma/tuikit";
import type { Theme } from "../theme.ts";
import { SPINNER_FRAMES } from "../symbols.ts";

export interface GitStatus {
  readonly branch: string;
  readonly dirty: boolean;
}

export interface FooterView {
  readonly model: string;
  readonly effort?: string;
  readonly cwd: string;
  readonly git: GitStatus | null;
  readonly mcpServers:
    | ReadonlyArray<{ readonly id: string; readonly toolCount: number }>
    | null;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly lastInputTokens: number;
  readonly contextWindow: number | null;
  readonly activity: string | null;
  readonly spinnerFrame: number;
  readonly hints: readonly string[];
}

const GAP = "  ";

const formatTokens = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) {
    const n = value / 1_000;
    return `${n >= 100 ? Math.round(n) : n.toFixed(1)}k`;
  }
  const n = value / 1_000_000;
  return `${n >= 100 ? Math.round(n) : n.toFixed(1)}M`;
};

const abbreviatePath = (path: string): string => {
  let value = path;
  try {
    const home = Deno.env.get("HOME");
    if (home && value === home) value = "~";
    else if (home && value.startsWith(`${home}/`)) {
      value = `~${value.slice(home.length)}`;
    }
  } catch {
    // Environment access is optional in embedded/headless use.
  }
  const prefix = value.startsWith("~/")
    ? "~/"
    : value.startsWith("/")
    ? "/"
    : "";
  const parts = value.replace(/^~?\//, "").split("/").filter(Boolean);
  if (parts.length <= 3) return value;
  return `${prefix}…/${parts.slice(-3).join("/")}`;
};

const append = (
  spans: StyledSpan[],
  text: string,
  style: StyledSpan["style"],
): void => {
  if (text.length === 0) return;
  if (spans.length > 0) spans.push({ text: GAP, style: {} });
  spans.push({ text, style });
};

const row = (
  left: readonly StyledSpan[],
  right: readonly StyledSpan[],
  width: number,
): StyledLine => {
  const safeWidth = Math.max(1, width);
  const rightLine = fitLine({ spans: right }, safeWidth);
  const rightWidth = lineWidth(rightLine);
  if (left.length === 0 || rightWidth >= safeWidth) {
    const pad = Math.max(0, safeWidth - rightWidth);
    return {
      spans: [
        { text: " ".repeat(pad), style: {} },
        ...rightLine.spans,
      ],
    };
  }

  const gapWidth = right.length > 0 ? stringWidth(GAP) : 0;
  const leftBudget = Math.max(0, safeWidth - rightWidth - gapWidth);
  const leftLine = fitLine({ spans: left }, leftBudget);
  const used = lineWidth(leftLine) + rightWidth;
  const middle = Math.max(0, safeWidth - used);
  return {
    spans: [
      ...leftLine.spans,
      { text: " ".repeat(middle), style: {} },
      ...rightLine.spans,
    ],
  };
};

export const renderFooter = (
  view: FooterView,
  width: number,
  theme: Theme,
): StyledLine[] => {
  const spinner = SPINNER_FRAMES[
    view.spinnerFrame % SPINNER_FRAMES.length
  ] ?? SPINNER_FRAMES[0];

  const primary: StyledSpan[] = [];
  append(primary, view.model, { fg: theme.primary, bold: true });
  if (view.effort) append(primary, view.effort, { fg: theme.textDim });
  append(primary, abbreviatePath(view.cwd), { fg: theme.textDim, dim: true });
  if (view.git?.branch) {
    append(primary, view.git.branch, { fg: theme.textDim, dim: true });
    if (view.git.dirty) {
      primary.push({ text: " ±", style: { fg: theme.warning } });
    }
  }

  const activity: StyledSpan[] = view.activity
    ? [{
      text: `${spinner} ${view.activity}`,
      style: { fg: theme.accent, bold: true },
    }]
    : [];

  const hints: StyledSpan[] = view.hints.length === 0 ? [] : [{
    text: view.hints.join(" · "),
    style: { fg: theme.textMuted, dim: true },
  }];

  const metrics: StyledSpan[] = [];
  if (view.contextWindow !== null && view.contextWindow > 0) {
    const pct = Math.min(
      999,
      Math.round((view.lastInputTokens / view.contextWindow) * 100),
    );
    append(metrics, `ctx ${pct}%`, { fg: theme.textDim });
  }
  append(
    metrics,
    `↑${formatTokens(view.tokensIn)} ↓${formatTokens(view.tokensOut)}`,
    { fg: theme.textMuted, dim: true },
  );
  if (view.mcpServers === null) {
    append(metrics, `${spinner} mcp`, { fg: theme.textMuted, dim: true });
  } else if (view.mcpServers.length > 0) {
    append(metrics, `mcp ${view.mcpServers.length}`, {
      fg: theme.success,
      dim: true,
    });
  }

  return [
    row(primary, activity, width),
    row(hints, metrics, width),
  ];
};
