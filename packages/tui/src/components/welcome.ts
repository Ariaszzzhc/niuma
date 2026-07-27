// ===========================================================================
// @niuma/tui — empty-session welcome
// ---------------------------------------------------------------------------
// Compact Niuma-branded orientation panel. It borrows Kimi Code's useful
// hierarchy (identity, one action hint, session facts) without copying its
// logo, palette, symbols, or wording.
// ===========================================================================

import { fitLine, renderBlock, type StyledLine } from "@niuma/tuikit";
import type { Theme } from "../theme.ts";

export interface WelcomeView {
  readonly version: string;
  readonly workspace: string;
  readonly sessionId: string | null;
  readonly model: string | null;
  readonly mcpServers: ReadonlyArray<{
    readonly id: string;
    readonly toolCount: number;
  }>;
}

const infoRow = (
  label: string,
  value: string,
  theme: Theme,
): StyledLine => ({
  spans: [
    { text: label.padEnd(11), style: { fg: theme.textDim, bold: true } },
    { text: value, style: { fg: theme.text } },
  ],
});

const indent = (
  lines: readonly StyledLine[],
  left: number,
): StyledLine[] =>
  lines.map((line) => ({
    spans: [{ text: " ".repeat(left), style: {} }, ...line.spans],
  }));

export const renderWelcome = (
  view: WelcomeView,
  width: number,
  theme: Theme,
): StyledLine[] => {
  const safeWidth = Math.max(1, width);
  const model = view.model ?? "waiting for session";
  if (safeWidth < 30) {
    return [
      { spans: [{ text: "niuma", style: { fg: theme.primary, bold: true } }] },
      {
        spans: [{
          text: "AI coding agent",
          style: { fg: theme.textDim, dim: true },
        }],
      },
      infoRow("model", model, theme),
      {
        spans: [{
          text: "Type /help for commands",
          style: { fg: theme.textMuted, dim: true },
        }],
      },
    ].map((line) => fitLine(line, safeWidth));
  }

  const boxWidth = Math.max(24, Math.min(76, safeWidth - 4));
  const title: StyledLine = {
    spans: [
      { text: "niuma", style: { fg: theme.primary, bold: true } },
      {
        text: "  AI coding agent",
        style: { fg: theme.textDim, dim: true },
      },
    ],
  };
  const content: StyledLine[] = [
    title,
    {
      spans: [{
        text: "Describe a task, or type /help to explore commands.",
        style: { fg: theme.textMuted },
      }],
    },
    { spans: [] },
    infoRow("Workspace", view.workspace, theme),
    infoRow("Session", view.sessionId ?? "starting…", theme),
    infoRow("Model", model, theme),
    infoRow("Version", view.version, theme),
  ];
  if (view.mcpServers.length > 0) {
    const tools = view.mcpServers.reduce(
      (total, server) => total + server.toolCount,
      0,
    );
    content.push(
      infoRow(
        "MCP",
        `${view.mcpServers.length} server${
          view.mcpServers.length === 1 ? "" : "s"
        } · ${tools} tools`,
        theme,
      ),
    );
  }

  const block = renderBlock(content, {
    width: boxWidth,
    borderColor: theme.border,
    paddingX: 2,
    paddingY: 1,
  });
  const left = Math.max(0, Math.floor((safeWidth - boxWidth) / 2));
  const output = indent(block, left);
  const blank: StyledLine = { spans: [] };
  return [blank, ...output, blank];
};
