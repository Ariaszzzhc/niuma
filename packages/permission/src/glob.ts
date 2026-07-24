const REGEX_META: ReadonlySet<string> = new Set([
  "\\",
  "^",
  "$",
  ".",
  "|",
  "+",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
]);

/**
 * Convert a glob pattern to an anchored RegExp. Semantics (picomatch-lite,
 * non-posix):
 *   - `*`  matches any run of characters INCLUDING `/`
 *   - `**` is treated identically to `*` (kept for compatibility)
 *   - `?`  matches a single character that is NOT `/`
 *   - any other regex metacharacter is escaped literally
 *
 * Examples:
 *   globToRegex("npm run *")        → /^npm run .*$/
 *   globToRegex("/etc/**")          → /^\/etc\/.*$/
 *   globToRegex("*.json")           → /^[^/]*\.json$/
 */
export function globToRegex(glob: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      while (i < glob.length && glob[i] === "*") i++;
      re += ".*";
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (REGEX_META.has(c)) {
      re += "\\" + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  re += "$";
  return new RegExp(re);
}
