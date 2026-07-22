import { isSensitivePath, normalizePath, normalizePattern } from "../src/sensitive.ts";

function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  if (actual !== expected) throw new Error(msg ?? `assertEquals: ${actual} !== ${expected}`);
}

const HOME = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";

Deno.test("normalizePath: absolute paths pass through", () => {
  assertEquals(normalizePath("/etc/passwd", "/work"), "/etc/passwd");
});

Deno.test("normalizePath: relative paths are joined with cwd", () => {
  assertEquals(normalizePath("src/foo.ts", "/work"), "/work/src/foo.ts");
  assertEquals(normalizePath("./a", "/work"), "/work/a");
});

Deno.test("normalizePath: collapses . and .. segments", () => {
  // Security-relevant: without collapsing, a target like `foo/./bar/id_rsa`
  // could slip past the `**/id_rsa` sensitive guard.
  assertEquals(normalizePath("./a", "/work"), "/work/a");
  assertEquals(normalizePath("a/./b", "/work"), "/work/a/b");
  assertEquals(normalizePath("a/b/../c", "/work"), "/work/a/c");
  assertEquals(normalizePath("../a", "/work"), "/a");
  assertEquals(normalizePath("/work/.git/config", "/work"), "/work/.git/config");
});

Deno.test("normalizePath: empty string passes through", () => {
  assertEquals(normalizePath("", "/work"), "");
});

Deno.test("normalizePath: ~ expands to HOME", () => {
  if (HOME.length === 0) return;
  assertEquals(normalizePath("~/.ssh/id_rsa", "/work"), HOME + "/.ssh/id_rsa");
});

Deno.test("normalizePattern: expands ~ at start", () => {
  if (HOME.length === 0) return;
  assertEquals(normalizePattern("~/.ssh/**"), HOME + "/.ssh/**");
  assertEquals(normalizePattern("/etc/**"), "/etc/**");
});

Deno.test("isSensitivePath: ~/.ssh is sensitive", () => {
  if (HOME.length === 0) return;
  assertEquals(isSensitivePath(HOME + "/.ssh/id_rsa", "/work"), true);
  assertEquals(isSensitivePath("~/.ssh/known_hosts", "/work"), true);
});

Deno.test("isSensitivePath: .env is sensitive", () => {
  assertEquals(isSensitivePath("/work/.env", "/work"), true);
  assertEquals(isSensitivePath("/work/.env.production", "/work"), true);
  assertEquals(isSensitivePath("/work/src/.env.local", "/work"), true);
});

Deno.test("isSensitivePath: id_rsa variants are sensitive", () => {
  assertEquals(isSensitivePath("/home/foo/id_rsa", "/work"), true);
  assertEquals(isSensitivePath("/home/foo/id_rsa.pub", "/work"), true);
});

Deno.test("isSensitivePath: .git is sensitive", () => {
  assertEquals(isSensitivePath("/work/.git/HEAD", "/work"), true);
  assertEquals(isSensitivePath("/work/.git/config", "/work"), true);
});

Deno.test("isSensitivePath: regular paths are not sensitive", () => {
  assertEquals(isSensitivePath("/work/src/main.ts", "/work"), false);
  assertEquals(isSensitivePath("/tmp/scratch.txt", "/work"), false);
  assertEquals(isSensitivePath("/work/README.md", "/work"), false);
});

Deno.test("isSensitivePath: ./ and ../ segments are collapsed before matching", () => {
  // Regression: pre-collapse these returned false because the literal "/./"
  // sat in the normalised path and broke the glob match.
  assertEquals(isSensitivePath("foo/./bar/id_rsa", "/work"), true);
  assertEquals(isSensitivePath("./.env", "/work"), true);
  assertEquals(isSensitivePath("sub/../.git/config", "/work"), true);
});

Deno.test("isSensitivePath: empty target is never sensitive", () => {
  assertEquals(isSensitivePath("", "/work"), false);
});