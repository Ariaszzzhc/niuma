import { globToRegex } from "./glob.ts";

export interface RuleSpec {
  readonly tool: string;
  readonly pattern: string;
}

export interface RuleWithAction extends RuleSpec {
  readonly action: "allow" | "deny" | "ask";
}

interface CompiledPattern {
  readonly regex: RegExp;
  readonly negate: boolean;
  readonly empty: boolean;
}

const patternCache = new Map<string, CompiledPattern>();

function compile(pattern: string): CompiledPattern {
  const cached = patternCache.get(pattern);
  if (cached) return cached;
  let negate = false;
  let pat = pattern;
  if (pat.startsWith("!")) {
    negate = true;
    pat = pat.slice(1);
  }
  const empty = pat.length === 0;
  const regex = empty ? /^$/ : globToRegex(pat);
  const compiled: CompiledPattern = { regex, negate, empty };
  patternCache.set(pattern, compiled);
  return compiled;
}

/**
 * Test whether a pattern matches a target string. A leading `!` in the
 * pattern negates the result: `!*` matches anything except the empty string.
 */
export function matchPattern(pattern: string, target: string): boolean {
  const c = compile(pattern);
  const m = c.empty ? target.length === 0 : c.regex.test(target);
  return c.negate ? !m : m;
}

/**
 * Compare tool names case-insensitively. Rules are written with the model's
 * capitalisation (`Bash`, `Read`); tool names at runtime are lowercase
 * (`bash`, `read`).
 */
export function toolMatches(ruleTool: string, actualTool: string): boolean {
  return ruleTool.toLowerCase() === actualTool.toLowerCase();
}

/** True iff the rule's tool matches AND the pattern matches the target. */
export function matchRule(
  rule: RuleSpec,
  toolName: string,
  target: string,
): boolean {
  if (!toolMatches(rule.tool, toolName)) return false;
  return matchPattern(rule.pattern, target);
}

/**
 * Walk an ordered list of rules and return the last one whose tool+pattern
 * matches. Returns `undefined` if no rule matches. This implements the
 * "last match wins" semantics required by the policy chain.
 */
export function lastMatch<T extends RuleSpec>(
  rules: ReadonlyArray<T>,
  toolName: string,
  target: string,
): T | undefined {
  let last: T | undefined;
  for (const r of rules) {
    if (matchRule(r, toolName, target)) last = r;
  }
  return last;
}
