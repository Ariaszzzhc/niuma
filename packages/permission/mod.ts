export const PERMISSION_VERSION = "0.0.0";

export { parseRule, parseRuleWithAction } from "./src/parser.ts";
export type { ParsedRule } from "./src/parser.ts";

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
  SENSITIVE_PATTERNS,
  isSensitivePath,
  normalizePath,
  normalizePattern,
} from "./src/sensitive.ts";

export { READ_ONLY_TOOLS, runPolicy, toDecision } from "./src/policy.ts";
export type { Verdict } from "./src/policy.ts";

export {
  PermissionEngine,
  makePermissionEngine,
} from "./src/engine.ts";
export type {
  PermissionEngineOptions,
  PermissionEngineShape,
  PermissionEngineSnapshot,
} from "./src/engine.ts";

export {
  DEFAULT_BUILTINS,
  defaultConfigPath,
  loadUserRules,
  loadUserRulesEffect,
} from "./src/config.ts";
