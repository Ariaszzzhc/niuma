export interface ParsedRule {
  readonly tool: string;
  readonly pattern: string;
}

/**
 * Parse a rule string like `Bash(npm run *)`, `Read(/etc/**)`, `Bash(*)` or
 * `!Read(/etc/passwd)` into `{tool, pattern}`. The tool name is lowercased;
 * the pattern is preserved verbatim, including any leading `!` (which the
 * matcher interprets as negation).
 *
 * The leading `!` may appear either before the tool name (`!Bash(...)`) or
 * inside the pattern (`Bash(!npm run *)`); both forms produce a pattern
 * whose first character is `!`.
 *
 * Throws on malformed input — callers (config loader, tests) are expected
 * to surface or swallow the error as appropriate.
 */
export function parseRule(input: string): ParsedRule {
  if (typeof input !== "string") {
    throw new Error("permission: rule must be a string");
  }
  let s = input.trim();
  if (s.length === 0) throw new Error("permission: empty rule");

  let negate = false;
  if (s.startsWith("!")) {
    negate = true;
    s = s.slice(1).trim();
  }

  const open = s.indexOf("(");
  if (open <= 0) {
    throw new Error(`permission: missing '(' in rule: ${input}`);
  }
  const close = s.lastIndexOf(")");
  if (close <= open || close !== s.length - 1) {
    throw new Error(`permission: missing or unmatched ')' in rule: ${input}`);
  }

  const tool = s.slice(0, open).trim();
  const inner = s.slice(open + 1, close).trim();

  if (!tool) throw new Error(`permission: empty tool name in rule: ${input}`);
  if (!inner) throw new Error(`permission: empty pattern in rule: ${input}`);

  const pattern = negate ? "!" + inner : inner;
  return { tool: tool.toLowerCase(), pattern };
}

/**
 * Parse a rule string that may carry an action prefix: e.g. `allow Bash(*)`.
 * Recognised prefixes are `allow`, `deny`, `ask` (case-insensitive). When
 * no prefix is given the action defaults to `ask`.
 */
export function parseRuleWithAction(
  input: string,
  defaultAction: "allow" | "deny" | "ask" = "ask",
): {
  readonly tool: string;
  readonly pattern: string;
  readonly action: "allow" | "deny" | "ask";
} {
  const trimmed = input.trim();
  const m = /^([Aa][Ll][Ll][Oo][Ww]|[Dd][Ee][Nn][Yy]|[Aa][Ss][Kk])\s+(.+)$/
    .exec(trimmed);
  if (!m) {
    const parsed = parseRule(trimmed);
    return {
      tool: parsed.tool,
      pattern: parsed.pattern,
      action: defaultAction,
    };
  }
  const action = m[1].toLowerCase() as "allow" | "deny" | "ask";
  const parsed = parseRule(m[2]);
  return { tool: parsed.tool, pattern: parsed.pattern, action };
}
