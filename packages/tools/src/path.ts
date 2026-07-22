import { isAbsolute, normalize, relative, resolve } from "@std/path";

const isWindowsPath = (p: string) => /^[a-zA-Z]:[\\/]/.test(p);

export interface ResolvedPath {
  abs: string;
  rel: string;
}

/**
 * Resolve `path` against `cwd` and verify it stays within `root`. Returns
 * the absolute and workspace-relative paths. Throws a tagged error when
 * the path escapes the root — tools surface this as `isError: true`.
 */
export function resolvePath(
  cwd: string,
  path: string,
  root: string = cwd,
): ResolvedPath {
  if (path === "") throw new PathError("path must not be empty");
  const abs = isAbsolute(path) || isWindowsPath(path)
    ? normalize(path)
    : resolve(cwd, path);
  const rootAbs = resolve(root);
  const rel = relative(rootAbs, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new PathError(`path escapes workspace root: ${path}`);
  }
  return { abs, rel };
}

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathError";
  }
}