export { globToRegex } from "./src/glob.ts";

export {
  lastMatch,
  matchPattern,
  matchRule,
  toolMatches,
} from "./src/matcher.ts";
export type { RuleSpec, RuleWithAction } from "./src/matcher.ts";

export {
  FILE_TOOLS,
  isSensitivePath,
  normalizePath,
  normalizePattern,
  SENSITIVE_PATTERNS,
} from "./src/sensitive.ts";

export { READ_ONLY_TOOLS, runPolicy } from "./src/policy.ts";
export type { Verdict } from "./src/policy.ts";
