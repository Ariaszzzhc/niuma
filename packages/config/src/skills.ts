// ===========================================================================
// Agent skills: reusable instruction packs discovered as `SKILL.md` files:
//
//   1. <agents skills dir>          (~/.agents/skills — cross-tool standard)
//   2. <global config dir>/skills   (~/.niuma/skills — wins over level 1)
//   3. <dir>/.niuma/skills for every dir on the project-config path
//      (the dirs projectConfigDirs finds walking from the workspace up to
//      $HOME; closer dirs win, all of them beat levels 1-2)
//
// A skill is a `SKILL.md` with a `---` frontmatter block of simple
// `key: value` scalars (hand-parsed — no YAML dependency; same policy as
// custom slash commands in commands.ts). Required keys: `name`,
// `description` — a file missing either is skipped silently. Unknown keys
// are tolerated. Unlike commands, the skill name comes from the frontmatter,
// not the directory name; the directory is purely organizational (its path
// is kept on `dir` so the model can resolve relative paths in the body).
//
// Each level is scanned recursively for `**/SKILL.md` down to depth 4 so a
// pathological tree cannot run away. Conflicts resolve per skill name: a
// higher-priority level replaces the lower one wholesale; within one level
// the path-sorted first discovery wins (deterministic). Missing/unreadable
// dirs yield an empty level; an unreadable file is skipped, never fatal.
//
// The system prompt carries only the name+description listing; the body is
// loaded on demand through the `skill` tool (packages/tools), which also
// applies slash-command argument expansion ($ARGUMENTS / $1..$N via
// expandCommandTemplate). Bodies are capped at 32 KiB at discovery time so
// a bloated file cannot blow the context; truncation precedes expansion, so
// expansion cannot re-inflate beyond args size. ~/.claude/skills is
// deliberately NOT read.
// ===========================================================================

import { dirname, join } from "@std/path";
import { PROJECT_DIR_BASENAME, projectConfigDirs } from "./config.ts";

export const SKILLS_DIR_BASENAME = "skills";
export const SKILL_FILE_BASENAME = "SKILL.md";

/** Directory descent bound for the recursive SKILL.md scan. */
export const SKILLS_MAX_DEPTH = 4;

/** Hard cap on a skill body, in UTF-8 bytes (context-size guard). */
export const SKILL_BODY_CAP_BYTES = 32 * 1024;

export const SKILL_BODY_TRUNCATED_MARKER =
  "[truncated: skill body capped at 32 KiB]";

export interface SkillDef {
  /** Skill name (frontmatter `name`) — the key the `skill` tool looks up. */
  readonly name: string;
  /** One-line description for the system-prompt listing (frontmatter). */
  readonly description: string;
  /** The instruction body (file minus frontmatter, capped at 32 KiB). */
  readonly body: string;
  /** Directory containing the SKILL.md; relative paths in the body resolve
   * against it. */
  readonly dir: string;
  /** Which level the file came from. */
  readonly source: "user" | "project";
}

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

// Trim, then cap at SKILL_BODY_CAP_BYTES UTF-8 bytes, appending the marker
// on a new line when the cap fired. Slicing at the byte boundary may split
// a multi-byte codepoint; the decoder replaces the partial tail with U+FFFD,
// which is acceptable for a guard rail.
const capBody = (body: string): string => {
  const trimmed = body.trim();
  const bytes = new TextEncoder().encode(trimmed);
  if (bytes.length <= SKILL_BODY_CAP_BYTES) return trimmed;
  const cut = new TextDecoder().decode(bytes.slice(0, SKILL_BODY_CAP_BYTES));
  return `${cut}\n${SKILL_BODY_TRUNCATED_MARKER}`;
};

/**
 * Parse a SKILL.md file's text. A leading `---` block is treated as
 * frontmatter: each line must look like `key: value` — a line that doesn't
 * ends the frontmatter there (same bail-out policy as parseCommandFile, so
 * a markdown hr near the top is never mangled). Returns null when the
 * required `name` or `description` is missing/empty — the file is skipped.
 */
export const parseSkillFile = (
  text: string,
  dir: string,
  source: "user" | "project",
): SkillDef | null => {
  let name: string | undefined;
  let description: string | undefined;
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
      // Non key:value content before any closing ---: not frontmatter at
      // all — bail out and treat the whole file as the body.
      break;
    }
    if (end >= 0) {
      for (const line of lines.slice(0, end)) {
        const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
        if (!m) continue;
        const key = m[1].toLowerCase();
        const value = m[2].trim();
        if (key === "name") name = value;
        else if (key === "description") description = value;
      }
      body = lines.slice(end + 1).join(newline);
    }
  }

  if (name === undefined || name === "") return null;
  if (description === undefined || description === "") return null;

  return { name, description, body: capBody(body), dir, source };
};

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

// DFS collecting SKILL.md paths. `depth` counts descents from the scanned
// root (files directly inside it are depth 0); subdirectories are entered
// only while depth < SKILLS_MAX_DEPTH, so a SKILL.md at directory depth 4
// is found and one at depth 5 is not. An unreadable directory just yields
// whatever was collected so far.
const walkSkillsDir = async (
  dir: string,
  depth: number,
  out: string[],
): Promise<void> => {
  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const entry of Deno.readDir(dir)) entries.push(entry);
  } catch {
    return; // unreadable dir — treat as absent
  }
  for (const entry of entries) {
    if (entry.isFile && entry.name === SKILL_FILE_BASENAME) {
      out.push(join(dir, entry.name));
    } else if (entry.isDirectory && depth < SKILLS_MAX_DEPTH) {
      await walkSkillsDir(join(dir, entry.name), depth + 1, out);
    }
  }
};

/** Load every SKILL.md under `dir` (recursive, depth ≤ 4); missing dir yields {}. */
const loadSkillsDir = async (
  dir: string,
  source: "user" | "project",
): Promise<Record<string, SkillDef>> => {
  const paths: string[] = [];
  await walkSkillsDir(dir, 0, paths);
  // Path-sorted so same-level name conflicts resolve deterministically:
  // the first discovery wins.
  paths.sort();
  const out: Record<string, SkillDef> = {};
  for (const path of paths) {
    let text: string;
    try {
      text = await Deno.readTextFile(path);
    } catch {
      continue; // unreadable file — skip, don't sink the rest
    }
    const def = parseSkillFile(text, dirname(path), source);
    if (def === null || out[def.name] !== undefined) continue;
    out[def.name] = def;
  }
  return out;
};

export interface LoadSkillsOptions {
  /** Global niuma config dir (niumaPaths().config); level 2 lives inside it.
   * Omit to skip that level (tests with injected infra). */
  readonly globalConfigDir?: string;
  /** Cross-tool agents skills dir (~/.agents/skills); level 1. Omit to skip
   * it. */
  readonly agentsSkillsDir?: string;
  /** Session workspace; anchors level 3 discovery. */
  readonly workspace: string;
}

/**
 * Load the effective skill table: the agents skills dir, then the global
 * skills dir, then every project-dir .niuma/skills (shallow → deep, so the
 * closest directory wins and all of them beat the user levels — the same
 * convention as .niuma/config.toml and commands). Conflicts are resolved per
 * skill name: the higher-priority level's skill replaces the lower one
 * wholesale.
 */
export const loadSkills = async (
  opts: LoadSkillsOptions,
): Promise<ReadonlyMap<string, SkillDef>> => {
  const levels: Array<Record<string, SkillDef>> = [];
  if (opts.agentsSkillsDir !== undefined) {
    levels.push(await loadSkillsDir(opts.agentsSkillsDir, "user"));
  }
  if (opts.globalConfigDir !== undefined) {
    levels.push(
      await loadSkillsDir(
        join(opts.globalConfigDir, SKILLS_DIR_BASENAME),
        "user",
      ),
    );
  }
  // projectConfigDirs is leaf-first; merge shallow-first so the closest
  // directory wins (same convention as .niuma/config.toml).
  const projectDirs = projectConfigDirs(opts.workspace)
    .map((dir) => join(dir, PROJECT_DIR_BASENAME, SKILLS_DIR_BASENAME))
    .reverse();
  for (const dir of projectDirs) {
    levels.push(await loadSkillsDir(dir, "project"));
  }
  const merged: Record<string, SkillDef> = Object.assign({}, ...levels);
  return new Map(Object.entries(merged));
};
