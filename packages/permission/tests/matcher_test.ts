import {
  lastMatch,
  matchPattern,
  matchRule,
  toolMatches,
} from "../src/matcher.ts";

function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(msg ?? `assertEquals: ${a} !== ${b}`);
}

Deno.test("matchPattern: literal", () => {
  assertEquals(matchPattern("hello", "hello"), true);
  assertEquals(matchPattern("hello", "world"), false);
});

Deno.test("matchPattern: * matches anything including /", () => {
  assertEquals(matchPattern("npm run *", "npm run build"), true);
  assertEquals(matchPattern("*", "anything goes"), true);
  assertEquals(matchPattern("src/*", "src/a/b"), true);
  assertEquals(matchPattern("src/*", "notsrc/x"), false);
});

Deno.test("matchPattern: ? matches a single non-slash char", () => {
  assertEquals(matchPattern("?.ts", "a.ts"), true);
  // `?` is exactly one non-slash character, so ".ts" (zero leading chars) and
  // "ab.ts" (two) both fail. Consistent with glob_test.ts "?.txt" cases.
  assertEquals(matchPattern("?.ts", ".ts"), false);
  assertEquals(matchPattern("?.ts", "ab.ts"), false);
});

Deno.test("matchPattern: leading '!' negates", () => {
  assertEquals(matchPattern("!*", "foo"), false);
  assertEquals(matchPattern("!foo", "foo"), false);
  assertEquals(matchPattern("!foo", "bar"), true);
  assertEquals(matchPattern("!*.test.ts", "src/foo.ts"), true);
});

Deno.test("toolMatches: case-insensitive", () => {
  assertEquals(toolMatches("Bash", "bash"), true);
  assertEquals(toolMatches("bash", "BASH"), true);
  assertEquals(toolMatches("Bash", "read"), false);
});

Deno.test("matchRule: matches only when both tool and pattern match", () => {
  assertEquals(
    matchRule({ tool: "bash", pattern: "npm *" }, "bash", "npm run build"),
    true,
  );
  assertEquals(
    matchRule({ tool: "bash", pattern: "npm *" }, "bash", "git status"),
    false,
  );
  assertEquals(
    matchRule({ tool: "bash", pattern: "npm *" }, "read", "npm run build"),
    false,
  );
});

Deno.test("lastMatch: returns the last matching rule (LAST wins)", () => {
  const rules = [
    { tool: "bash", pattern: "*", action: "allow" as const },
    { tool: "bash", pattern: "rm *", action: "deny" as const },
    { tool: "bash", pattern: "*", action: "ask" as const },
  ];
  assertEquals(lastMatch(rules, "bash", "rm foo")?.action, "ask");
  assertEquals(lastMatch(rules, "bash", "npm run *")?.action, "ask");
  assertEquals(lastMatch(rules, "read", "/etc/passwd"), undefined);
});

Deno.test("lastMatch: empty rules → undefined", () => {
  assertEquals(lastMatch([], "bash", "anything"), undefined);
});

Deno.test("matchPattern: empty pattern matches only the empty string", () => {
  // compile("") short-circuits to /^$/ rather than going through globToRegex.
  assertEquals(matchPattern("", ""), true);
  assertEquals(matchPattern("", "x"), false);
  assertEquals(matchPattern("", "anything"), false);
});

Deno.test("matchPattern: empty negated pattern ('!') matches any non-empty target", () => {
  // compile("!") → negate=true, empty=true → matches iff target != "".
  assertEquals(matchPattern("!", ""), false);
  assertEquals(matchPattern("!", "x"), true);
  assertEquals(matchPattern("!", "anything"), true);
});

Deno.test("compile cache: same pattern string reused across calls stays consistent", () => {
  // The module-level patternCache keys on the raw pattern string. A pattern
  // and its negated form share no key, so both results must be coherent even
  // when interleaved.
  for (let i = 0; i < 3; i++) {
    assertEquals(matchPattern("*.ts", "a/b.ts"), true);
    assertEquals(matchPattern("!*.ts", "a/b.ts"), false);
    assertEquals(matchPattern("*.ts", "a/b.js"), false);
    assertEquals(matchPattern("!*.ts", "a/b.js"), true);
  }
});

Deno.test("compile cache: leading '!' negation stays coherent", () => {
  // The matcher's compile() must interpret a leading "!" as negation
  // regardless of cache state.
  // Repeating the call exercises the cached CompiledPattern branch.
  const target = "rm -rf /";
  for (let i = 0; i < 3; i++) {
    assertEquals(matchPattern("!*", target), false);
    assertEquals(matchPattern("*", target), true);
  }
});

Deno.test("matchPattern: '*' glob crosses '/' for path-like targets (cache hot)", () => {
  // After the previous tests the "*" CompiledPattern is cached; verify it
  // still matches across path separators.
  assertEquals(matchPattern("src/*", "src/a/b/c"), true);
  assertEquals(matchPattern("src/*", "othersrc/x"), false);
});
