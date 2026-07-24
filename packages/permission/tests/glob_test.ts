import { globToRegex } from "../src/glob.ts";

function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  if (actual !== expected) {
    throw new Error(msg ?? `assertEquals: ${actual} !== ${expected}`);
  }
}

Deno.test("globToRegex: * matches anything including /", () => {
  const re = globToRegex("*");
  assertEquals(re.test("foo"), true);
  assertEquals(re.test("foo/bar/baz"), true);
  assertEquals(re.test(""), true);
});

Deno.test("globToRegex: ** is identical to *", () => {
  const re = globToRegex("src/**");
  assertEquals(re.test("src/a/b/c.ts"), true);
  assertEquals(re.test("notsrc/x"), false);
});

Deno.test("globToRegex: ? matches single non-slash character", () => {
  const re = globToRegex("?.txt");
  assertEquals(re.test("a.txt"), true);
  assertEquals(re.test("ab.txt"), false);
  assertEquals(re.test("/.txt"), false);
});

Deno.test("globToRegex: anchors the result", () => {
  const re = globToRegex("foo");
  assertEquals(re.test("foo"), true);
  assertEquals(re.test("foobar"), false);
});

Deno.test("globToRegex: escapes regex metacharacters", () => {
  const re = globToRegex("a.b+c|d");
  assertEquals(re.test("a.b+c|d"), true);
  assertEquals(re.test("axbxxcxd"), false);
});

Deno.test("globToRegex: empty pattern matches only empty string", () => {
  const re = globToRegex("");
  assertEquals(re.test(""), true);
  assertEquals(re.test("x"), false);
});
