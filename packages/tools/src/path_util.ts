import { isAbsolute, normalize, relative, resolve } from "@std/path";

// Skip these by default in walk-based tools (grep/glob/read).
export const ALWAYS_IGNORE_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "dist",
  "build",
  "target",
  "vendor",
  "__pycache__",
]);

/**
 * Resolve `path` against `cwd` and verify it stays within `root`.
 * Throws if the path escapes — tools surface the error as `isError`.
 *
 * `root` defaults to `cwd`; tools that want to expose the wider filesystem
 * explicitly pass a wider root.
 */
export function resolveWithinRoot(
  cwd: string,
  path: string,
  root: string = cwd,
): string {
  if (path === "") throw new Error("path must not be empty");
  const abs = isAbsolute(path) ? normalize(path) : resolve(cwd, path);
  const rootAbs = resolve(root);
  const rel = relative(rootAbs, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path escapes workspace root: ${path}`);
  }
  return abs;
}

/** True if `path` is inside `root` (after resolution). */
export function isWithinRoot(cwd: string, path: string, root: string): boolean {
  try {
    resolveWithinRoot(cwd, path, root);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `dir` should be skipped during a filesystem walk. Skips:
 *   - dot-directories (`.git`, `.next`, `.cache`, ...) — generally build
 *     artifacts or VCS metadata the model shouldn't trawl
 *   - the canonical ALWAYS_IGNORE_DIRS set (node_modules, dist, build, ...)
 *
 * Used by grep/glob's JS fallback walks; the rg shell-out has its own
 * default ignore rules but we pass `--no-ignore-vcs` to keep behaviour
 * consistent.
 */
export function shouldSkipDir(name: string): boolean {
  if (!name) return false;
  if (name.startsWith(".")) return true;
  return ALWAYS_IGNORE_DIRS.has(name);
}

/**
 * Coalesce overlapping accesses — the scheduler treats two tool calls as
 * conflicting when one writes a path the other reads/writes.
 *
 * Returns the list of pairs of (i, j) that conflict.
 */
export function conflicts(
  a: readonly string[],
  b: readonly string[],
): string[] {
  const out: string[] = [];
  for (const x of a) {
    for (const y of b) {
      if (x === y) {
        out.push(x);
        continue;
      }
      if (x.endsWith("/") && y.startsWith(x)) {
        out.push(x);
        continue;
      }
      if (y.endsWith("/") && x.startsWith(y)) {
        out.push(y);
      }
    }
  }
  return out;
}
