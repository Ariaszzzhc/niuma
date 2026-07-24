import { isSensitivePath, normalizePath, normalizePattern } from "../src/sensitive.ts";
import { resolve } from "@std/path";

function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  if (actual !== expected) {
    throw new Error(msg ?? `assertEquals: ${actual} !== ${expected}`);
  }
}

const HOME = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";

// Expectations are expressed through the same forward-slash normalisation the
// matcher applies, so the assertions hold on Windows (drive-letter roots,
// backslash HOME) as well as on Unix.
const R = (p: string): string => resolve(p).replaceAll("\\", "/");
const S = (p: string): string => p.replaceAll("\\", "/");

Deno.test("normalizePath: absolute paths pass through", () => {
  assertEquals(normalizePath("/etc/passwd", "/work"), R("/etc/passwd"));
});

Deno.test("normalizePath: relative paths are joined with cwd", () => {
  assertEquals(normalizePath("src/foo.ts", "/work"), R("/work/src/foo.ts"));
  assertEquals(normalizePath("./a", "/work"), R("/work/a"));
});

Deno.test("normalizePath: collapses . and .. segments", () => {
  // Security-relevant: without collapsing, a target like `foo/./bar/id_rsa`
  // could slip past the `**/id_rsa` sensitive guard.
  assertEquals(normalizePath("./a", "/work"), R("/work/a"));
  assertEquals(normalizePath("a/./b", "/work"), R("/work/a/b"));
  assertEquals(normalizePath("a/b/../c", "/work"), R("/work/a/c"));
  assertEquals(normalizePath("../a", "/work"), R("/a"));
  assertEquals(normalizePath("/work/.git/config", "/work"), R("/work/.git/config"));
});

Deno.test("normalizePath: empty string passes through", () => {
  assertEquals(normalizePath("", "/work"), "");
});

Deno.test("normalizePath: ~ expands to HOME", () => {
  if (HOME.length === 0) return;
  assertEquals(normalizePath("~/.ssh/id_rsa", "/work"), S(HOME) + "/.ssh/id_rsa");
});

Deno.test("normalizePattern: expands ~ at start", () => {
  if (HOME.length === 0) return;
  assertEquals(normalizePattern("~/.ssh/**"), S(HOME) + "/.ssh/**");
  assertEquals(normalizePattern("/etc/**"), "/etc/**");
});

Deno.test("isSensitivePath: Windows backslash paths are normalised before matching", () => {
  // Regression: pre-normalisation a `C:\...` target never matched the
  // `/`-separated sensitive globs, silently disabling the guard on Windows.
  assertEquals(isSensitivePath("C:\\Users\\foo\\.ssh\\id_rsa", "C:\\work"), true);
  assertEquals(isSensitivePath("D:\\work\\.env", "D:\\work"), true);
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
