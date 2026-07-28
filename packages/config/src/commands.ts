// ===========================================================================
// Custom slash commands: user-defined prompt templates living in `commands/`
// dirs next to the existing config files:
//
//   1. <global config dir>/commands/*.md   (~/.niuma/commands)
//   2. <dir>/.niuma/commands/*.md for every dir on the project-config path
//      (the dirs projectConfigDirs finds walking from the workspace up to
//      $HOME; closer dirs win, all of them beat level 1)
//
// A command file is markdown with an optional `---` frontmatter block of
// simple `key: value` scalars (hand-parsed — no YAML dependency; same
// policy as old codex prompts). Recognised keys: `description`,
// `argument-hint` (also `argument_hint`). Unknown lines are tolerated. The
// command name is the file's basename without `.md`; the body is the prompt
// template.
//
// Templates support `$ARGUMENTS` (the whole argument string) and `$1`..`$N`
// positional placeholders; the highest-numbered placeholder swallows all
// remaining arguments (opencode's semantics). When the template has no
// placeholders at all and arguments were given, they are appended at the
// end. Expansion happens server-side (packages/server) so every client —
// TUI, one-shot, serve — shares one code path and the Session Journal records
// expanded text.
//
// The user's typed input (e.g. `/review src/foo.ts`) is preserved separately
// as `sourceText` on the user.message event; nothing in this module knows
// about that — see packages/server/src/session.ts.
// ===========================================================================

import { expandGlob } from "@std/fs";
import { basename, join } from "@std/path";
import { PROJECT_DIR_BASENAME, projectConfigDirs } from "./config.ts";

export const COMMANDS_DIR_BASENAME = "commands";

export interface CommandDef {
  /** Command name: the file's basename without `.md` (e.g. `review`). */
  readonly name: string;
  /** One-line description for palette listings (frontmatter). */
  readonly description?: string;
  /** Argument hint shown next to the command (frontmatter). */
  readonly argumentHint?: string;
  /** The prompt template (file body minus frontmatter). */
  readonly template: string;
  /** Which level the file came from. */
  readonly source: "user" | "project";
  /** Absolute path of the defining file (diagnostics). */
  readonly filePath: string;
}

/** Effective command table, keyed by command name. */
export type CommandTable = ReadonlyMap<string, CommandDef>;

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

/**
 * Parse a command file's text. A leading `---` block is treated as
 * frontmatter: each line must look like `key: value` — a line that doesn't
 * ends the frontmatter there (the rest, including that line, is body),
 * keeping hand-written markdown files with a `---` rule near the top from
 * being mangled. A `---` opener with no closing `---` means there is no
 * frontmatter at all.
 */
export const parseCommandFile = (
  text: string,
  name: string,
  source: "user" | "project",
  filePath: string,
): CommandDef => {
  let description: string | undefined;
  let argumentHint: string | undefined;
  let body = text;

  if (body.startsWith("---\n") || body.startsWith("---\r\n")) {
    const newline = body.startsWith("---\r\n") ? "\r\n" : "\n";
    const rest = body.slice(3 + newline.length);
    const lines = rest.split(newline);
    let end = -1; // index of the closing --- line
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === "---" || line === "---\r") {
        end = i;
        break;
      }
      if (/^[A-Za-z][A-Za-z0-9_-]*\s*:/.test(line)) continue;
      // Blank lines inside frontmatter are allowed.
      if (line.trim() === "") continue;
      // Non key:value content before any closing ---: this is not
      // frontmatter at all (e.g. a markdown hr near the top) — bail out and
      // treat the whole file as the template.
      break;
    }
    if (end >= 0) {
      for (const line of lines.slice(0, end)) {
        const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
        if (!m) continue;
        const key = m[1].toLowerCase();
        const value = m[2].trim();
        if (key === "description") description = value;
        else if (key === "argument-hint" || key === "argument_hint") {
          argumentHint = value;
        }
      }
      body = lines.slice(end + 1).join(newline);
    }
  }

  return {
    name,
    ...(description !== undefined && description !== "" ? { description } : {}),
    ...(argumentHint !== undefined && argumentHint !== ""
      ? { argumentHint }
      : {}),
    template: body.trim(),
    source,
    filePath,
  };
};

// ---------------------------------------------------------------------------
// Template expansion
// ---------------------------------------------------------------------------

// Quote-aware argument splitter: `"..."` / `'...'` group, everything else
// splits on whitespace (opencode's argsRegex, minus its image-token clause).
const ARGS_REGEX = /(?:"[^"]*"|'[^']*'|[^\s"']+)/g;

const PLACEHOLDER_REGEX = /\$(\d+)/g;
const ARGUMENTS_PLACEHOLDER = "$ARGUMENTS";

const unquote = (s: string): string =>
  (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
    ? s.slice(1, -1)
    : s;

/**
 * Expand a command template against its raw argument string.
 *
 * - `$ARGUMENTS` → the raw string, verbatim.
 * - `$1`..`$N` → positional arguments (quote-aware split, quotes stripped).
 *   The highest-numbered placeholder swallows all remaining arguments, so
 *   `ask $1 about $2` with `a b c d` yields `$2 === "b c d"`.
 * - Placeholders with no matching argument expand to the empty string.
 * - A template with no placeholders at all gets the raw arguments appended
 *   after a blank line (when any were given).
 */
export const expandCommandTemplate = (
  template: string,
  rawArgs: string,
): string => {
  const trimmed = rawArgs.trim();
  const args = (trimmed.match(ARGS_REGEX) ?? []).map(unquote);

  const hasArguments = template.includes(ARGUMENTS_PLACEHOLDER);
  const indices = Array.from(
    template.matchAll(PLACEHOLDER_REGEX),
    (m) => Number(m[1]),
  );
  const maxIndex = indices.length > 0 ? Math.max(...indices) : 0;

  if (!hasArguments && maxIndex === 0) {
    return trimmed === "" ? template : `${template}\n\n${trimmed}`;
  }

  let out = template;
  if (hasArguments) out = out.replaceAll(ARGUMENTS_PLACEHOLDER, trimmed);
  return out.replace(
    PLACEHOLDER_REGEX,
    (_whole, n: string) => {
      const i = Number(n);
      if (i === maxIndex) return args.slice(i - 1).join(" ");
      return args[i - 1] ?? "";
    },
  );
};

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Load every `*.md` directly inside `dir`; missing dir yields {}. */
const loadCommandsDir = async (
  dir: string,
  source: "user" | "project",
): Promise<Record<string, CommandDef>> => {
  const out: Record<string, CommandDef> = {};
  let entries: Array<{ path: string; name: string }>;
  try {
    entries = [];
    for await (
      const entry of expandGlob(join(dir, "*.md"), { includeDirs: false })
    ) {
      entries.push({ path: entry.path, name: basename(entry.path, ".md") });
    }
  } catch {
    return out; // unreadable dir — treat as absent
  }
  for (const entry of entries) {
    let text: string;
    try {
      text = await Deno.readTextFile(entry.path);
    } catch {
      continue; // unreadable file — skip, don't sink the rest
    }
    out[entry.name] = parseCommandFile(text, entry.name, source, entry.path);
  }
  return out;
};

export interface LoadCommandsOptions {
  /** Global niuma config dir (niumaPaths().config); level 1 lives inside it.
   * Omit to skip the user level (tests with injected infra). */
  readonly globalConfigDir?: string;
  /** Session workspace; anchors level 2 discovery. */
  readonly workspace: string;
}

/**
 * Load the effective command table: the global commands dir, then every
 * project-dir .niuma/commands (shallow → deep, so the closest directory wins
 * and all of them beat the global dir — the same convention as
 * .niuma/config.toml and .niuma/mcp.json). Conflicts are resolved per command
 * name: the higher-priority file's command replaces the lower one wholesale.
 */
export const loadCommands = async (
  opts: LoadCommandsOptions,
): Promise<CommandTable> => {
  const levels: Array<Record<string, CommandDef>> = [];
  if (opts.globalConfigDir !== undefined) {
    levels.push(
      await loadCommandsDir(
        join(opts.globalConfigDir, COMMANDS_DIR_BASENAME),
        "user",
      ),
    );
  }
  // projectConfigDirs is leaf-first; merge shallow-first so the closest
  // directory wins (same convention as .niuma/config.toml).
  const projectDirs = projectConfigDirs(opts.workspace)
    .map((dir) => join(dir, PROJECT_DIR_BASENAME, COMMANDS_DIR_BASENAME))
    .reverse();
  for (const dir of projectDirs) {
    levels.push(await loadCommandsDir(dir, "project"));
  }
  const merged: Record<string, CommandDef> = Object.assign({}, ...levels);
  return new Map(Object.entries(merged));
};
