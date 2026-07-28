// ===========================================================================
// @niuma/tui — built-in slash command registry + parsing (pure)
// ---------------------------------------------------------------------------
// The TUI owns a set of BUILT-IN slash commands (/help /exit /model /effort
// /delivery /compact /clear /resume /mcp, plus the /quit alias) that are handled
// locally: when the editor submits `/name args` and `name` is built-in, the
// app dispatches it here instead of POSTing a prompt (custom commands/*.md
// templates are expanded server-side, so anything NOT in this registry falls
// through to the prompt path). Priority on a name collision: built-in wins
// over custom.
//
// This module is PURE (no IO, no app/client imports beyond types): it holds
// the registry, the `/name args` parser, the /resume id resolver, the
// completion-menu candidate list, and the text builders for /help and the
// session list. `app.ts` keeps the effectful dispatch; `palette.ts` derives
// its built-in rows from BUILTIN_COMMANDS.
// ===========================================================================

import type { SessionInfo } from "@niuma/schema";
import type { ClientCommand } from "./client.ts";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface BuiltinCommand {
  /** Canonical name WITHOUT the leading slash. */
  readonly name: string;
  readonly description: string;
  /** True when the command takes an argument: the palette seeds the editor
   * with `/name ` (like a custom command) instead of executing immediately.
   * Bare use still works from the editor (shows the current value / picker). */
  readonly takesArg: boolean;
  /** Alternative spellings that resolve to this command (e.g. /quit). */
  readonly aliases?: readonly string[];
}

export const BUILTIN_COMMANDS: readonly BuiltinCommand[] = [
  {
    name: "help",
    description: "Show key bindings and commands",
    takesArg: false,
  },
  {
    name: "exit",
    description: "Quit niuma",
    takesArg: false,
    aliases: ["quit"],
  },
  { name: "model", description: "Show or switch the model", takesArg: true },
  {
    name: "effort",
    description: "Show or set the thinking effort",
    takesArg: true,
  },
  {
    name: "delivery",
    description: "Show or set prompt delivery (steer or queue)",
    takesArg: true,
  },
  {
    name: "compact",
    description: "Compact the conversation context",
    takesArg: false,
  },
  { name: "clear", description: "Start a fresh session", takesArg: false },
  { name: "resume", description: "Resume a previous session", takesArg: true },
  { name: "mcp", description: "List connected MCP servers", takesArg: false },
];

/** Look up a built-in command by name or alias (case-insensitive). */
export const findBuiltinCommand = (
  name: string,
): BuiltinCommand | undefined => {
  const needle = name.toLowerCase();
  return BUILTIN_COMMANDS.find((c) =>
    c.name === needle || c.aliases?.includes(needle) === true
  );
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface ParsedBuiltinCommand {
  /** Canonical command name (alias-resolved, e.g. "quit" -> "exit"). */
  readonly name: string;
  /** Trimmed argument text ("" when none was given). */
  readonly args: string;
}

/**
 * Parse `^/name args...` and resolve it against the built-in registry.
 * Returns null when the text is not a slash command at all OR the name is
 * not built-in — in both cases the caller falls through to the prompt path
 * (the server expands custom commands; unmatched `/whatever` passes through
 * as plain text).
 */
export const parseBuiltinCommand = (
  text: string,
): ParsedBuiltinCommand | null => {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (m === null) return null;
  const cmd = findBuiltinCommand(m[1]);
  if (cmd === undefined) return null;
  return { name: cmd.name, args: (m[2] ?? "").trim() };
};

// ---------------------------------------------------------------------------
// /resume id resolution (exact, else unique prefix)
// ---------------------------------------------------------------------------

export type SessionIdResolution =
  | { readonly type: "ok"; readonly sessionId: string }
  | { readonly type: "ambiguous"; readonly matches: readonly string[] }
  | { readonly type: "not-found" };

/** Resolve a user-typed session id: exact match wins, otherwise a UNIQUE
 * prefix match; zero matches is not-found, several is ambiguous. */
export const resolveSessionId = (
  ids: readonly string[],
  query: string,
): SessionIdResolution => {
  if (ids.includes(query)) return { type: "ok", sessionId: query };
  const matches = ids.filter((id) => id.startsWith(query));
  if (matches.length === 1) return { type: "ok", sessionId: matches[0] };
  if (matches.length > 1) return { type: "ambiguous", matches };
  return { type: "not-found" };
};

// ---------------------------------------------------------------------------
// Completion candidates (editor `/partial` -> completion menu rows)
// ---------------------------------------------------------------------------

/** One row of the slash-command completion menu. */
export interface CompletionCandidate {
  /** Command name WITHOUT the leading slash. */
  readonly name: string;
  readonly description?: string;
  /** Built-in commands (and aliases) dispatch locally; custom ones are
   * expanded server-side. */
  readonly builtin: boolean;
}

/**
 * The completion-menu candidate list for a slash-command name prefix
 * (WITHOUT the leading slash): built-ins + aliases + the session's custom
 * commands, filtered case-insensitively by prefix and sorted by name.
 * Dedupe is case-insensitive with built-ins winning — a custom command
 * shadowing a built-in name appears once, since the built-in wins at
 * dispatch time. Pure; app.ts re-derives this on every editor change.
 */
export const slashCommandCandidates = (
  prefix: string,
  custom: readonly { readonly name: string; readonly description?: string }[],
): readonly CompletionCandidate[] => {
  const seen = new Set<string>();
  const out: CompletionCandidate[] = [];
  const push = (c: CompletionCandidate): void => {
    const key = c.name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };
  for (const c of BUILTIN_COMMANDS) {
    push({ name: c.name, description: c.description, builtin: true });
    for (const alias of c.aliases ?? []) {
      push({
        name: alias,
        description: `${c.description} (alias for /${c.name})`,
        builtin: true,
      });
    }
  }
  for (const c of custom) {
    push({
      name: c.name,
      ...(c.description !== undefined ? { description: c.description } : {}),
      builtin: false,
    });
  }
  const lower = prefix.toLowerCase();
  return out
    .filter((c) => c.name.toLowerCase().startsWith(lower))
    .sort((a, b) => a.name.localeCompare(b.name));
};

// ---------------------------------------------------------------------------
// Text builders
// ---------------------------------------------------------------------------

const KEYS_LINE =
  "enter submit · shift+enter/ctrl+j newline · / menu (tab/enter select) · ctrl+p palette · ctrl+o expand · esc/ctrl+c interrupt · ctrl+c/d quit · ctrl+- undo";

/** /help output: key bindings, the built-in commands, then custom commands. */
export const helpLines = (
  custom: readonly ClientCommand[],
): readonly string[] => {
  const lines = [
    KEYS_LINE,
    `commands: ${BUILTIN_COMMANDS.map((c) => `/${c.name}`).join("  ")}`,
  ];
  if (custom.length > 0) {
    lines.push(
      `custom commands: ${custom.map((c) => `/${c.name}`).join("  ")}`,
    );
  }
  return lines;
};

/** One line per known session for bare /resume (id, status, model, title). */
export const formatSessionList = (
  sessions: readonly SessionInfo[],
): readonly string[] => {
  if (sessions.length === 0) return ["no sessions found"];
  return sessions.map((s) => {
    const title = s.title !== undefined && s.title.length > 0
      ? `  ${s.title}`
      : "";
    return `${s.sessionId}  [${s.status}]  ${s.model}${title}`;
  });
};
