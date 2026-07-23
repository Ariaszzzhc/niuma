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
    "You are niuma, a minimal server-first AI coding agent.",
    "",
    "You operate in a one-shot headless turn: read context, use tools to",
    "inspect and modify the workspace, then produce a final answer.",
    "",
    "Tool usage:",
    "- Prefer reading files before editing them.",
    "- Keep tool calls minimal and purposeful; batch independent calls.",
    "- Use bash for shell commands; read/write/edit/apply_patch for files;",
    "  grep/glob for search. Explain destructive actions before running them.",
    "- When the task is complete, stop calling tools and give a concise answer.",
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
export async function buildSystemPrompt(
  workspace: string,
  cwd: string = workspace,
): Promise<string> {
  const base = baseInstructions();
  const listing = await listWorkspaceFiles(workspace);
  const env = environmentContext(workspace, listing);
  const head = `${base}\n\n${env}`;
  const agents = await discoverAgentsMd(workspace, cwd);
  return agents.length > 0 ? `${head}\n\n---\n\n${agents}` : head;
}
