import { resolve } from "@std/path";
import { matchPattern } from "./matcher.ts";

/**
 * Tools whose target is a filesystem path. The sensitive-path guard applies
 * only to these; bash uses the rule DSL and the raw command string.
 */
export const FILE_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "write",
  "edit",
  "apply_patch",
  "grep",
  "glob",
]);

/**
 * Glob patterns considered sensitive. Touching a path that matches any of
 * these (after normalisation) forces an `Ask` verdict, even if a more
 * permissive allow rule is present. The list mirrors kimi / opencode
 * defaults; extend with care.
 */
export const SENSITIVE_PATTERNS: ReadonlyArray<string> = [
  "~/.ssh/**",
  "**/.ssh/**",
  "**/.env",
  "**/.env.*",
  "**/id_rsa",
  "**/id_rsa.*",
  "**/.git/**",
];

function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
    if (p === "~") return home;
    return home + p.slice(1);
  }
  return p;
}

/**
 * Normalise a target path so that rule/guard matching is stable.
 *
 * `~` and `~/...` are expanded to the user's home directory first; then the
 * path is resolved against `cwd` using `@std/path`'s `resolve`, which
 * collapses `.` and `..` segments and yields an absolute path. This is
 * security-relevant: without collapsing, a target like `foo/./bar/id_rsa`
 * could slip past the `id_rsa` sensitive guard.
 */
export function normalizePath(p: string, cwd: string): string {
  if (p.length === 0) return p;
  const expanded = expandHome(p);
  // `resolve` treats an absolute second arg as authoritative (returns it
  // unchanged after collapsing), and joins relative paths onto cwd while
  // collapsing . and .. segments.
  return resolve(cwd, expanded);
}

/** Normalise a glob pattern's leading `~/` so it can be matched against absolute paths. */
export function normalizePattern(pattern: string): string {
  if (pattern === "~" || pattern.startsWith("~/")) {
    const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
    if (pattern === "~") return home;
    return home + pattern.slice(1);
  }
  return pattern;
}

/**
 * Decide whether a path target touches a sensitive location. Both the
 * raw target and its cwd-relative/absolute form are checked against the
 * expanded patterns — this lets rules written as `~/.ssh/**` match against
 * either form of the target string.
 */
export function isSensitivePath(target: string, cwd: string): boolean {
  if (target.length === 0) return false;
  const normalised = normalizePath(target, cwd);
  for (const raw of SENSITIVE_PATTERNS) {
    const expanded = normalizePattern(raw);
    if (matchPattern(expanded, normalised)) return true;
    if (matchPattern(expanded, target)) return true;
  }
  return false;
}