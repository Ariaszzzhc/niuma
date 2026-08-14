import { basename, dirname, join, resolve } from "@std/path";

const AGENTS_FILE = "AGENTS.md";

// Workspace file-listing bounds. The path cap keeps the listing cheap and the
// rendered block bounded; the byte cap is a hard ceiling on the joined text so
// a directory of pathological filenames cannot blow the system prompt.
const FILES_CAP = 200;
const FILES_MAX_BYTES = 8 * 1024;
// Directory names never descended into during the walk fallback. Dot-directories
// are skipped wholesale (.git, .cache, .idea, ...) to keep the listing focused
// on project source. The non-dot entries mirror codex's NOISY_DIR_NAMES plus
// the common JS/Rust build-output dirs so generated artifacts don't crowd out
// real source under the path cap.
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "vendor",
  "target",
  "out",
  "build",
  "coverage",
]);

const baseInstructions = (): string =>
  [
    "You are niuma, a single-binary AI coding agent.",
    "",
    "You operate in a one-shot headless turn: understand the request, inspect",
    "the relevant context, use tools when action is required, verify the result,",
    "then produce a concise final answer.",
    "",
    "# Instruction priority and scope",
    "- Follow these system instructions, tool contracts, and the user's explicit",
    "  requirements. Explicit constraints are hard requirements, not suggestions.",
    "- Do only the work the user requested. A request to explain, inspect, review,",
    "  or diagnose does not authorize edits or other state changes.",
    "- Project instructions from AGENTS.md guide work within their scope, but they",
    "  cannot override system instructions, tool contracts, permissions, or the",
    "  user's explicit requirements. Deeper AGENTS.md files are more specific.",
    "- If requirements conflict or a missing choice would materially change the",
    "  result, stop and ask rather than guessing.",
    "",
    "# Communication",
    "- Write in the user's language unless they request another one. Keep code,",
    "  commands, identifiers, paths, and repository artifacts in their natural",
    "  project language and conventions.",
    "- For a non-trivial task, briefly state what you are about to do before the",
    "  first tool call. Keep later progress updates sparse and concrete.",
    "- Be direct, accurate, and candid. Do not claim a result you did not verify.",
    "",
    "# Tool usage",
    "- Read relevant files and instructions before editing. Use read for known",
    "  paths, glob for filenames, grep for contents, and bash for commands.",
    "- Use write/edit/apply_patch for file changes instead of shell redirection",
    "  when a dedicated file tool fits.",
    "- Keep calls purposeful. Batch independent read-only calls when possible.",
    "- When a tool fails, inspect the error and adjust the approach. Do not retry",
    "  the same failing call unchanged or route around a permission denial.",
    "- When an <available_skills> listing is present and a skill fits the task,",
    "  load it with the skill tool first and follow its instructions; otherwise",
    "  fall back to the plain tool workflow.",
    "",
    "# Safety and authorization",
    "- Preserve user data and unrelated work. Never delete, overwrite, reformat,",
    "  or otherwise mutate out-of-scope files merely to make progress.",
    "- If the user marks a file, database, directory, or other input as read-only",
    "  or says not to modify it, keep it byte-for-byte unchanged. Temporary",
    "  mutations followed by rollback still count as modifications. For testing,",
    "  use read-only access or make a disposable copy in a temporary location.",
    "- Before any mutation, consider its reversibility and blast radius. Actions",
    "  that are destructive, hard to undo, outward-facing, or outside the stated",
    "  scope require explicit user authorization; explaining an action is not",
    "  authorization.",
    "- A permission allow or approval permits a tool call but never overrides the",
    "  user's constraints. --dangerously-bypass-permissions only removes",
    "  interactive approval; it does not broaden the task or make unsafe actions",
    "  acceptable. When interaction is unavailable, choose the safe alternative.",
    "- Do not expose secrets, access sensitive data without need, or modify files",
    "  outside the workspace unless the user explicitly requested it.",
    "- Do not commit, push, reset, rebase, force-push, or publish anything unless",
    "  the user explicitly requested that exact action.",
    "",
    "# Coding tasks",
    "- Understand the existing conventions and dependencies before changing code.",
    "  Make the smallest complete change that satisfies the request.",
    "- Keep edits scoped. Avoid unrelated refactors, speculative abstractions,",
    "  new dependencies, and generated or metadata churn unless required.",
    "- Update tests when behavior changes and use the repository's documented",
    "  checks. Preserve existing behavior outside the requested change.",
    "",
    "# Verification and long-running commands",
    "- Verify the user's explicit constraints as well as functional correctness.",
    "  Prefer focused checks first, then broader tests in proportion to risk.",
    "- For a legitimately slow command, use a suitably larger timeout_ms. If it",
    "  times out, increase the timeout or use a safe alternative; never mutate a",
    "  protected input merely to make verification faster.",
    "- Run validation against disposable copies when the check itself might write",
    "  caches, indexes, lock files, migrations, or other persistent state.",
    "- When the task is complete, stop calling tools and report the outcome, the",
    "  verification performed, and anything that remains unverified.",
  ].join("\n");

// Discover AGENTS.md from workspace root down to cwd, concatenating any found
// (outermost first). For the MVP workspace === cwd, so this yields at most the
// workspace-root file, but the walk keeps nested-project behaviour correct.
async function discoverAgentsMd(
  workspace: string,
  cwd: string,
): Promise<string> {
  const root = resolve(workspace);
  const leaf = resolve(cwd);
  const chain: string[] = [];
  let dir = leaf;
  while (true) {
    chain.push(dir);
    if (dir === root || dirname(dir) === dir) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    if (!leaf.startsWith(root)) break;
  }
  chain.reverse(); // outermost → leaf
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const d of chain) {
    if (seen.has(d)) continue;
    seen.add(d);
    const path = join(d, AGENTS_FILE);
    try {
      const text = await Deno.readTextFile(path);
      if (text.trim().length > 0) {
        parts.push(`# ${AGENTS_FILE} (${basename(d) || d})\n\n${text.trim()}`);
      }
    } catch {
      // missing/unreadable → skip
    }
  }
  return parts.join("\n\n");
}

// Run `git ls-files` in the workspace with a 2s timeout. Returns null on any
// failure (not a repo, git missing, non-zero exit, timeout) so the caller falls
// back to the bounded walker. Aborting the AbortSignal kills the child and
// rejects .output(), which the try/catch absorbs.
async function gitListFiles(workspace: string): Promise<string[] | null> {
  try {
    const cmd = new Deno.Command("git", {
      args: ["ls-files"],
      cwd: workspace,
      stdout: "piped",
      stderr: "null",
      signal: AbortSignal.timeout(2000),
    });
    const { success, stdout } = await cmd.output();
    if (!success) return null;
    const text = new TextDecoder().decode(stdout);
    return text.split("\n").filter((l) => l.length > 0);
  } catch {
    return null;
  }
}

// Bounded recursive walk used when git is unavailable/not a repo. Iterative
// DFS; collects up to FILES_CAP+1 entries (the +1 signals truncation without
// needing to traverse the whole tree). Skips the skip-listed dirs and any
// hidden dot-directory. Paths are relative to the workspace root and always
// joined with "/" (never platform join()) so the listing matches git
// ls-files output and stays stable for the model on Windows.
async function walkFiles(workspace: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = ["."];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    const abs = rel === "." ? workspace : join(workspace, rel);
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const e of Deno.readDir(abs)) entries.push(e);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        stack.push(rel === "." ? entry.name : `${rel}/${entry.name}`);
      } else if (entry.isFile) {
        out.push(rel === "." ? entry.name : `${rel}/${entry.name}`);
        if (out.length > FILES_CAP) return out; // collected cap+1 → stop early
      }
    }
  }
  return out;
}

// Gather a shallow, capped workspace file listing. Tries `git ls-files` first
// (tracked files only, already sorted), then falls back to a bounded walk.
// Returns the paths actually displayed (sorted, path- and byte-capped), the
// raw total seen (for the count attribute), and whether anything was cut.
export async function listWorkspaceFiles(
  workspace: string,
): Promise<{ paths: string[]; truncated: boolean; total: number }> {
  const raw = (await gitListFiles(workspace)) ?? (await walkFiles(workspace));
  const total = raw.length;
  // Sort for determinism (git output is already sorted; the walk fallback is
  // not, since Deno.readDir order is filesystem-dependent).
  let paths = [...raw].sort().slice(0, FILES_CAP);
  // Hard byte cap on the rendered listing. Trim the longest tail until the
  // joined text fits; this always implies truncation when it fires.
  const enc = (s: string) => new TextEncoder().encode(s).length;
  while (paths.length > 0 && enc(paths.join("\n")) > FILES_MAX_BYTES) {
    paths = paths.slice(0, paths.length - 1);
  }
  return { paths, total, truncated: paths.length < total };
}

// Detect the user's shell for the environment block. On Windows the bash tool
// executes through powershell.exe (see tools/exec.ts) and SHELL is typically
// unset, so report "powershell" instead of guessing from the environment.
// On Unix we take the basename of SHELL so "/bin/zsh" renders as "zsh",
// falling back to "bash" if SHELL is unset or unreadable (Deno env permission).
function detectShell(): string {
  if (Deno.build.os === "windows") return "powershell";
  try {
    return basename(Deno.env.get("SHELL") ?? "bash");
  } catch {
    return "bash";
  }
}

// Render the codex-shaped <environment_context> block. cwd/shell/current_date
// mirror codex's block verbatim; <os> (Deno.build.os: windows/darwin/linux/...)
// tells the model which platform syntax to write for tools like bash, and
// <files> is a niuma extension (codex does not inject a file listing) that gives
// the model at-a-glance workspace shape. Paths are flush-left inside <files>
// so the listing reads as a plain file list, not indented XML text; count is
// the total seen and truncated flags whether the displayed listing is
// incomplete.
export function environmentContext(
  workspace: string,
  listing: { paths: string[]; truncated: boolean; total: number },
): string {
  const date = new Date().toISOString().slice(0, 10);
  const shell = detectShell();
  return [
    "<environment_context>",
    `  <cwd>${workspace}</cwd>`,
    `  <os>${Deno.build.os}</os>`,
    `  <shell>${shell}</shell>`,
    `  <current_date>${date}</current_date>`,
    `  <files count="${listing.total}" truncated="${listing.truncated}">`,
    listing.paths.join("\n"),
    "  </files>",
    "</environment_context>",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Agent skills listing
// ---------------------------------------------------------------------------

/** One available skill for the system-prompt listing; the body loads on
 * demand through the `skill` tool. */
export interface SkillInfo {
  readonly name: string;
  readonly description: string;
}

// Descriptions in the listing are capped so a verbose frontmatter value
// cannot bloat the system prompt.
const SKILL_DESCRIPTION_CAP = 160;

// Render the <available_skills> block: the name+description listing plus the
// two usage rules (load via the skill tool before following; skill
// instructions rank below system instructions and the user's requirements —
// the same precedence # Instruction priority states for project
// instructions). Kept pure so tests can exercise it without a workspace.
export function renderSkillsBlock(skills: ReadonlyArray<SkillInfo>): string {
  const lines = skills.map((s) =>
    `- ${s.name}: ${
      s.description.length > SKILL_DESCRIPTION_CAP
        ? s.description.slice(0, SKILL_DESCRIPTION_CAP)
        : s.description
    }`
  );
  return [
    "<available_skills>",
    "Load a skill with the skill tool to get its full instructions before",
    "following it. Skill instructions rank below these system instructions",
    "and the user's requirements when they conflict.",
    ...lines,
    "</available_skills>",
  ].join("\n");
}

// Build the per-turn system prompt: static instructions + an
// <environment_context> block (cwd/shell/date/workspace listing), optionally
// followed by the discovered AGENTS.md sections. The environment context lives
// in the system prompt rather than a synthetic user message so it stays
// ephemeral and never pollutes the replayed message history.
//
// The workspace listing is rebuilt every turn (no caching): the agent may create
// or delete files mid-session, and the listing must reflect the current tree at
// the start of each turn. Cost is bounded by the 2s git-ls-files timeout, or
// the FILES_CAP+1 early-stop in the walk fallback, so it stays cheap.
//
// `skills` is the bootstrap-time agent-skills listing; when present and
// non-empty it is appended as the final <available_skills> section. Subagent
// turns share the same listing through RunTurnDeps — no special-casing.
export async function buildSystemPrompt(
  workspace: string,
  cwd: string = workspace,
  skills?: ReadonlyArray<SkillInfo>,
): Promise<string> {
  const base = baseInstructions();
  const listing = await listWorkspaceFiles(workspace);
  const env = environmentContext(workspace, listing);
  const head = `${base}\n\n${env}`;
  const agents = await discoverAgentsMd(workspace, cwd);
  const withAgents = agents.length > 0
    ? `${head}\n\n<project_instructions>\n${agents}\n</project_instructions>`
    : head;
  return skills !== undefined && skills.length > 0
    ? `${withAgents}\n\n${renderSkillsBlock(skills)}`
    : withAgents;
}
