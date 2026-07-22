import { basename, dirname, join, resolve } from "@std/path";

const AGENTS_FILE = "AGENTS.md";

const baseInstructions = (workspace: string): string =>
  [
    "You are niuma, a minimal server-first AI coding agent.",
    `Working directory: ${workspace}`,
    `Today's date: ${new Date().toISOString().slice(0, 10)}`,
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

export async function buildSystemPrompt(
  workspace: string,
  cwd: string = workspace,
): Promise<string> {
  const base = baseInstructions(workspace);
  const agents = await discoverAgentsMd(workspace, cwd);
  return agents.length > 0
    ? `${base}\n\n---\n\n${agents}`
    : base;
}
