// ===========================================================================
// @niuma/tui — tool transcript renderers
// ---------------------------------------------------------------------------
// Built-in Niuma tools get high-information presentations tailored to their
// inputs and outputs. MCP tools share a generic renderer that decodes
// `mcp__server__tool`, shows provenance + the most meaningful argument and a
// three-visual-row result preview. Unknown tools use the same safe fallback.
//
// Product components own semantics; tuikit provides width-aware composition.
// No renderer mutates or persists state — ctrl+o arrives as `expanded`.
// ===========================================================================

import {
  fitLine,
  lineWidth,
  stringWidth,
  type StyledLine,
  type StyledSpan,
  truncateToWidth,
  wrapText,
} from "@niuma/tuikit";
import type { Theme } from "../theme.ts";
import {
  SPINNER_FRAMES,
  STATUS_ERROR,
  STATUS_SUCCESS,
  TREE_BRANCH,
} from "../symbols.ts";

export type ToolCallStatus = "running" | "done" | "error";

export interface ToolCallView {
  readonly name: string;
  readonly status: ToolCallStatus;
  /** Raw tool input for specialized renderers. */
  readonly input?: unknown;
  /** Safe fallback summary for malformed/unknown input. */
  readonly inputSummary: string;
  readonly resultLines: readonly string[];
  readonly durationMs?: number;
  readonly expanded: boolean;
  readonly activity?: string | null;
  /** Derived assistant-sampling step for compact parallel-call grouping. */
  readonly batchId?: number;
  /** Subagent lifecycle badge, present on spawn_subagent cards. */
  readonly subagent?: {
    readonly status: "running" | "done" | "failed";
    readonly durationMs: number;
    readonly tokensIn: number | null;
    readonly tokensOut: number | null;
  };
}

type DetailTone =
  | "normal"
  | "muted"
  | "success"
  | "warning"
  | "add"
  | "delete"
  | "context";

interface Detail {
  readonly text: string;
  readonly tone?: DetailTone;
}

interface Presentation {
  readonly title: string;
  readonly source?: string;
  readonly summary: string;
  readonly details: readonly Detail[];
  readonly previewRows: number;
  readonly hiddenHint?: boolean;
}

type InputRecord = Readonly<Record<string, unknown>>;

const asRecord = (value: unknown): InputRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as InputRecord
    : {};

const stringValue = (
  input: InputRecord,
  key: string,
): string | undefined =>
  typeof input[key] === "string" ? input[key] as string : undefined;

const numberValue = (
  input: InputRecord,
  key: string,
): number | undefined =>
  typeof input[key] === "number" && Number.isFinite(input[key])
    ? input[key] as number
    : undefined;

const compact = (value: string, max = 180): string => {
  const oneLine = value.replace(/\s+/gu, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, Math.max(0, max - 1))}…`;
};

const resultDetails = (
  call: ToolCallView,
  tone: DetailTone = "muted",
): Detail[] => call.resultLines.map((text) => ({ text, tone }));

const meaningfulArgument = (input: unknown): string => {
  const record = asRecord(input);
  for (
    const key of [
      "path",
      "command",
      "pattern",
      "query",
      "url",
      "prompt",
      "name",
      "id",
    ]
  ) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      return compact(value);
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return `${key}=${String(value)}`;
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return compact(`${key}=${String(value)}`);
    }
  }
  try {
    return compact(JSON.stringify(input) ?? "");
  } catch {
    return compact(String(input ?? ""));
  }
};

const readSummary = (input: unknown, fallback: string): string => {
  const value = asRecord(input);
  const path = stringValue(value, "path") ?? fallback;
  const offset = numberValue(value, "offset");
  const limit = numberValue(value, "limit");
  if (offset === undefined && limit === undefined) return path;
  const start = offset ?? 1;
  const end = limit === undefined ? "…" : String(start + limit - 1);
  return `${path}:${start}-${end}`;
};

const patchPresentation = (
  call: ToolCallView,
  input: InputRecord,
): Presentation => {
  const patch = stringValue(input, "patch") ?? "";
  const operations = patch.split(/\r?\n/u).filter((line) =>
    /^\s*\*\*\* (Add|Update|Delete) File:/u.test(line)
  );
  const firstPath = operations[0]?.replace(
    /^\s*\*\*\* (?:Add|Update|Delete) File:\s*/u,
    "",
  );
  const summary = operations.length === 0
    ? call.inputSummary
    : `${operations.length} file${operations.length === 1 ? "" : "s"}${
      firstPath ? ` · ${firstPath}` : ""
    }`;
  const details: Detail[] = [];
  for (const raw of patch.split(/\r?\n/u)) {
    const line = raw.trimEnd();
    if (
      line === "*** Begin Patch" ||
      line === "*** End Patch" ||
      line.trim() === ""
    ) continue;
    if (/^\s*\*\*\* (Add|Update|Delete) File:/u.test(line)) {
      details.push({
        text: line.replace(/^\s*\*\*\*\s*/u, ""),
        tone: "context",
      });
    } else if (line.startsWith("+")) {
      details.push({ text: line, tone: "add" });
    } else if (line.startsWith("-")) {
      details.push({ text: line, tone: "delete" });
    } else if (line.startsWith("@@")) {
      details.push({ text: line, tone: "context" });
    }
  }
  if (details.length === 0) details.push(...resultDetails(call));
  return {
    title: "Patch",
    summary,
    details,
    previewRows: 8,
  };
};

const editPresentation = (
  call: ToolCallView,
  input: InputRecord,
): Presentation => {
  const path = stringValue(input, "path") ?? call.inputSummary;
  const edits = Array.isArray(input.edits) ? input.edits : [];
  const details: Detail[] = [];
  for (const raw of edits) {
    const edit = asRecord(raw);
    const oldText = stringValue(edit, "oldText");
    const newText = stringValue(edit, "newText");
    if (oldText !== undefined) {
      for (const line of oldText.split(/\r?\n/u)) {
        details.push({ text: `- ${line}`, tone: "delete" });
      }
    }
    if (newText !== undefined) {
      for (const line of newText.split(/\r?\n/u)) {
        details.push({ text: `+ ${line}`, tone: "add" });
      }
    }
  }
  if (details.length === 0) details.push(...resultDetails(call));
  return {
    title: "Edit",
    summary: `${path}${
      edits.length > 0
        ? ` · ${edits.length} edit${edits.length === 1 ? "" : "s"}`
        : ""
    }`,
    details,
    previewRows: 6,
  };
};

const planPresentation = (
  call: ToolCallView,
  input: InputRecord,
): Presentation => {
  const items = Array.isArray(input.items) ? input.items : [];
  const details: Detail[] = items.map((raw) => {
    const item = asRecord(raw);
    const status = stringValue(item, "status") ?? "pending";
    const title = stringValue(item, "title") ?? "(untitled)";
    return {
      text: `${
        status === "done" ? "●" : status === "in_progress" ? "◐" : "○"
      } ${title}`,
      tone: status === "done"
        ? "success"
        : status === "in_progress"
        ? "warning"
        : "muted",
    };
  });
  if (details.length === 0) details.push(...resultDetails(call));
  return {
    title: "Plan",
    summary: `${items.length} item${items.length === 1 ? "" : "s"}`,
    details,
    previewRows: 8,
  };
};

interface McpName {
  readonly server: string;
  readonly tool: string;
}

export const parseMcpToolName = (name: string): McpName | null => {
  if (!name.startsWith("mcp__")) return null;
  const parts = name.slice("mcp__".length).split("__");
  if (parts.length < 2 || parts[0] === "" || parts.slice(1).join("__") === "") {
    return null;
  }
  return { server: parts[0], tool: parts.slice(1).join("__") };
};

const presentationFor = (call: ToolCallView): Presentation => {
  const input = asRecord(call.input);
  const mcp = parseMcpToolName(call.name);
  if (mcp !== null) {
    return {
      title: mcp.tool,
      source: `MCP · ${mcp.server}`,
      summary: meaningfulArgument(call.input),
      details: resultDetails(call),
      previewRows: 3,
    };
  }

  switch (call.name) {
    case "read":
    case "read_file":
      return {
        title: "Read",
        summary: readSummary(call.input, call.inputSummary),
        details: resultDetails(call),
        previewRows: 0,
        hiddenHint: false,
      };
    case "bash": {
      const command = stringValue(input, "command") ??
        stringValue(input, "cmd") ?? call.inputSummary;
      return {
        title: "Bash",
        summary: compact(command),
        details: resultDetails(call),
        previewRows: 3,
      };
    }
    case "write":
      return {
        title: "Write",
        summary: stringValue(input, "path") ?? call.inputSummary,
        details: resultDetails(call, "success"),
        previewRows: 1,
      };
    case "edit":
      return editPresentation(call, input);
    case "apply_patch":
      return patchPresentation(call, input);
    case "grep": {
      const pattern = stringValue(input, "pattern") ?? "";
      const path = stringValue(input, "path") ?? ".";
      return {
        title: "Search",
        summary: `${
          pattern === "" ? call.inputSummary : `"${pattern}"`
        } in ${path}`,
        details: resultDetails(call),
        previewRows: 3,
      };
    }
    case "glob": {
      const pattern = stringValue(input, "pattern") ?? call.inputSummary;
      const path = stringValue(input, "path") ?? ".";
      return {
        title: "Files",
        summary: `${pattern} in ${path}`,
        details: resultDetails(call),
        previewRows: 3,
      };
    }
    case "spawn_subagent": {
      const mode = stringValue(input, "mode") ?? "default";
      const prompt = stringValue(input, "prompt") ?? call.inputSummary;
      const sa = call.subagent;
      const badge = sa === undefined
        ? ""
        : sa.status === "running"
        ? " ◌ running"
        : sa.status === "failed"
        ? " ◍ failed"
        : " ● done";
      const usage =
        sa !== undefined && sa.tokensIn !== null && sa.tokensOut !== null
          ? ` · ${sa.tokensIn}/${sa.tokensOut} tok`
          : "";
      const duration = sa !== undefined && sa.durationMs > 0
        ? ` · ${formatDuration(sa.durationMs)}`
        : "";
      return {
        title: "Subagent",
        summary: `${mode} · ${compact(prompt, 140)}${badge}${usage}${duration}`,
        details: resultDetails(call),
        previewRows: 2,
      };
    }
    case "update_plan":
      return planPresentation(call, input);
    case "question": {
      const question = stringValue(input, "question") ?? call.inputSummary;
      const options = Array.isArray(input.options)
        ? input.options.filter((value): value is string =>
          typeof value === "string"
        )
        : [];
      return {
        title: "Question",
        summary: compact(question),
        details: [
          ...options.map((option, index) => ({
            text: `${index + 1}. ${option}`,
            tone: "muted" as const,
          })),
          ...resultDetails(call),
        ],
        previewRows: 3,
      };
    }
    default:
      return {
        title: call.name,
        summary: meaningfulArgument(call.input) || call.inputSummary,
        details: resultDetails(call),
        previewRows: 3,
      };
  }
};

const formatDuration = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

const statusGlyph = (
  call: ToolCallView,
  spinnerFrame: number,
  theme: Theme,
): StyledSpan => {
  switch (call.status) {
    case "running":
      return {
        text: SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length] ??
          SPINNER_FRAMES[0],
        style: { fg: theme.accent },
      };
    case "done":
      return { text: STATUS_SUCCESS, style: { fg: theme.success } };
    case "error":
      return { text: STATUS_ERROR, style: { fg: theme.error, bold: true } };
  }
};

const toneStyle = (
  tone: DetailTone | undefined,
  theme: Theme,
): StyledSpan["style"] => {
  switch (tone) {
    case "success":
      return { fg: theme.success };
    case "warning":
      return { fg: theme.warning };
    case "add":
      return { fg: theme.diffAdd };
    case "delete":
      return { fg: theme.diffDelete };
    case "context":
      return { fg: theme.diffContext, dim: true };
    case "normal":
      return { fg: theme.text };
    case "muted":
    default:
      return { fg: theme.textDim, dim: true };
  }
};

const renderHeader = (
  call: ToolCallView,
  presentation: Presentation,
  width: number,
  theme: Theme,
  spinnerFrame: number,
): StyledLine => {
  const bar = "│ ";
  const innerW = Math.max(1, width - stringWidth(bar));
  const duration = call.durationMs === undefined
    ? ""
    : formatDuration(call.durationMs);
  const durationW = stringWidth(duration);
  const durationGap = durationW > 0 ? 2 : 0;
  const leftBudget = Math.max(1, innerW - durationW - durationGap);
  const spans: StyledSpan[] = [
    statusGlyph(call, spinnerFrame, theme),
    { text: " ", style: {} },
    { text: presentation.title, style: { fg: theme.textStrong, bold: true } },
  ];
  if (presentation.source !== undefined && presentation.source !== "") {
    spans.push({
      text: `  ${presentation.source}`,
      style: { fg: theme.textMuted, dim: true },
    });
  }
  if (presentation.summary !== "") {
    spans.push({
      text: `  ${presentation.summary}`,
      style: { fg: theme.textDim },
    });
  }
  const left = fitLine({ spans }, leftBudget);
  const used = lineWidth(left);
  const pad = Math.max(0, innerW - used - durationW);
  return {
    spans: [
      { text: bar, style: { fg: theme.border, dim: true } },
      ...left.spans,
      { text: " ".repeat(pad), style: {} },
      ...(durationW > 0
        ? [{ text: duration, style: { fg: theme.textMuted, dim: true } }]
        : []),
    ],
  };
};

interface VisualDetail {
  readonly text: string;
  readonly tone?: DetailTone;
}

const visualDetails = (
  details: readonly Detail[],
  width: number,
): VisualDetail[] =>
  details.flatMap((detail) =>
    wrapText(detail.text, Math.max(1, width)).map((line) => ({
      text: line.spans.map((span) => span.text).join(""),
      tone: detail.tone,
    }))
  );

const renderPresentation = (
  call: ToolCallView,
  presentation: Presentation,
  width: number,
  theme: Theme,
  spinnerFrame: number,
): StyledLine[] => {
  const safeWidth = Math.max(1, width);
  const out = [
    renderHeader(call, presentation, safeWidth, theme, spinnerFrame),
  ];
  const bar = "│ ";
  const branch = `${TREE_BRANCH} `;
  const detailW = Math.max(
    1,
    safeWidth - stringWidth(bar) - stringWidth(branch),
  );
  const details = visualDetails(presentation.details, detailW);
  if (call.status === "running" && call.activity) {
    details.unshift({ text: call.activity, tone: "warning" });
  }
  const cap = call.expanded ? 24 : Math.max(0, presentation.previewRows);
  const shown = details.slice(0, cap);
  const hidden = details.length - shown.length;
  for (let index = 0; index < shown.length; index++) {
    const detail = shown[index];
    out.push({
      spans: [
        { text: bar, style: { fg: theme.border, dim: true } },
        {
          text: index === shown.length - 1 && hidden === 0 ? branch : "├ ",
          style: { fg: theme.border },
        },
        {
          text: truncateToWidth(detail.text, detailW),
          style: toneStyle(detail.tone, theme),
        },
      ],
    });
  }
  if (
    hidden > 0 &&
    (presentation.hiddenHint !== false || shown.length > 0)
  ) {
    out.push({
      spans: [
        { text: bar, style: { fg: theme.border, dim: true } },
        { text: branch, style: { fg: theme.border } },
        {
          text: truncateToWidth(
            call.expanded
              ? `+${hidden} more lines`
              : `ctrl+o for ${hidden} more line${hidden === 1 ? "" : "s"}`,
            detailW,
          ),
          style: { fg: theme.textMuted, dim: true },
        },
      ],
    });
  }
  return out;
};

export const isReadTool = (call: ToolCallView): boolean =>
  call.name === "read" || call.name === "read_file";

export const renderReadToolGroup = (
  calls: readonly ToolCallView[],
  width: number,
  theme: Theme,
  spinnerFrame = 0,
): StyledLine[] => {
  if (calls.length === 0) return [];
  const status: ToolCallStatus = calls.some((call) => call.status === "error")
    ? "error"
    : calls.some((call) => call.status === "running")
    ? "running"
    : "done";
  const duration = calls.reduce(
    (max, call) => Math.max(max, call.durationMs ?? 0),
    0,
  );
  const expanded = calls.some((call) => call.expanded);
  const aggregate: ToolCallView = {
    name: "read",
    status,
    inputSummary: "",
    resultLines: [],
    expanded,
    ...(duration > 0 ? { durationMs: duration } : {}),
  };
  const presentation: Presentation = {
    title: "Read",
    summary: `${calls.length} file${calls.length === 1 ? "" : "s"}`,
    details: calls.map((call) => ({
      text: readSummary(call.input, call.inputSummary),
      tone: call.status === "error" ? "warning" : "normal",
    })),
    previewRows: 6,
  };
  return renderPresentation(
    aggregate,
    presentation,
    width,
    theme,
    spinnerFrame,
  );
};

export const renderToolCall = (
  call: ToolCallView,
  width: number,
  theme: Theme,
  spinnerFrame = 0,
): StyledLine[] =>
  renderPresentation(
    call,
    presentationFor(call),
    width,
    theme,
    spinnerFrame,
  );
