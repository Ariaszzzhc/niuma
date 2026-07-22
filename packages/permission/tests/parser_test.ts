import { parseRule, parseRuleWithAction } from "../src/parser.ts";

function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(msg ?? `assertEquals: ${a} !== ${b}`);
}

function assertThrows(fn: () => unknown, msg?: string): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(msg ?? "expected throw");
}

Deno.test("parseRule: extracts tool and pattern", () => {
  assertEquals(parseRule("Bash(npm run *)"), { tool: "bash", pattern: "npm run *" });
  assertEquals(parseRule("Read(/etc/**)"), { tool: "read", pattern: "/etc/**" });
  assertEquals(parseRule("Edit(src/**)"), { tool: "edit", pattern: "src/**" });
  assertEquals(parseRule("Bash(*)"), { tool: "bash", pattern: "*" });
});

Deno.test("parseRule: lowercases tool name", () => {
  assertEquals(parseRule("BASH(*)"), { tool: "bash", pattern: "*" });
  assertEquals(parseRule("Write(/tmp/x)"), { tool: "write", pattern: "/tmp/x" });
});

Deno.test("parseRule: supports negation via leading rule-level '!'", () => {
  assertEquals(parseRule("!Bash(*)"), { tool: "bash", pattern: "!*" });
  assertEquals(parseRule("!Read(/etc/passwd)"), {
    tool: "read",
    pattern: "!/etc/passwd",
  });
});

Deno.test("parseRule: supports negation inside the pattern", () => {
  assertEquals(parseRule("Bash(!npm run *)"), { tool: "bash", pattern: "!npm run *" });
});

Deno.test("parseRule: trims whitespace", () => {
  assertEquals(parseRule("  Bash (  npm run *  ) "), {
    tool: "bash",
    pattern: "npm run *",
  });
});

Deno.test("parseRule: throws on malformed input", () => {
  assertThrows(() => parseRule(""));
  assertThrows(() => parseRule("Bash"));
  assertThrows(() => parseRule("()"));
  assertThrows(() => parseRule("Bash("));
  assertThrows(() => parseRule("Bash)"));
  assertThrows(() => parseRule("(npm run *)"));
});

Deno.test("parseRuleWithAction: reads action prefix", () => {
  assertEquals(parseRuleWithAction("allow Bash(*)"), {
    tool: "bash",
    pattern: "*",
    action: "allow",
  });
  assertEquals(parseRuleWithAction("deny Read(/etc/**)"), {
    tool: "read",
    pattern: "/etc/**",
    action: "deny",
  });
  assertEquals(parseRuleWithAction("ASK Bash(npm run *)"), {
    tool: "bash",
    pattern: "npm run *",
    action: "ask",
  });
});

Deno.test("parseRuleWithAction: defaults to ask when no prefix", () => {
  assertEquals(parseRuleWithAction("Bash(*)"), {
    tool: "bash",
    pattern: "*",
    action: "ask",
  });
});