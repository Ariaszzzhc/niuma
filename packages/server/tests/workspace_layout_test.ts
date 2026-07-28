import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  ensureWorkspaceLayout,
  makeWorkspaceLayout,
  WorkspaceKeyCollisionError,
  workspaceKeyFromAbsolutePath,
} from "../src/workspace_layout.ts";

Deno.test("WorkspaceLayout uses Claude-style readable POSIX keys", () => {
  assertEquals(
    workspaceKeyFromAbsolutePath(
      "/Users/arias/Projects/ariaszzzhc/napkin",
      "posix",
    ),
    "-Users-arias-Projects-ariaszzzhc-napkin",
  );
  assertEquals(workspaceKeyFromAbsolutePath("/", "posix"), "-");
  assertEquals(
    workspaceKeyFromAbsolutePath("/tmp/你好 world", "posix"),
    "-tmp-你好 world",
  );
});

Deno.test("WorkspaceLayout normalizes Windows drive and UNC keys", () => {
  assertEquals(
    workspaceKeyFromAbsolutePath("C:\\Users\\arias\\work", "windows"),
    "C-Users-arias-work",
  );
  assertEquals(
    workspaceKeyFromAbsolutePath("\\\\server\\share\\work", "windows"),
    "-UNC-server-share-work",
  );
});

Deno.test("WorkspaceLayout keeps Session and Usage directories on one key", () => {
  const layout = makeWorkspaceLayout("/tmp/niuma-data", "/tmp/a/../napkin");
  assertEquals(layout.workspace, "/tmp/napkin");
  assertEquals(layout.workspaceKey, "-tmp-napkin");
  assertEquals(
    layout.sessions,
    join("/tmp/niuma-data", "sessions", "-tmp-napkin"),
  );
  assertEquals(
    layout.usage,
    join("/tmp/niuma-data", "usage", "-tmp-napkin"),
  );
});

Deno.test("WorkspaceLayout identity detects a flattened-key collision", async () => {
  const root = await Deno.makeTempDir();
  try {
    const first = makeWorkspaceLayout(root, "/tmp/foo-bar/baz");
    const second = makeWorkspaceLayout(root, "/tmp/foo/bar-baz");
    assertEquals(first.workspaceKey, second.workspaceKey);
    await ensureWorkspaceLayout(first);
    await assertRejects(
      () => ensureWorkspaceLayout(second),
      WorkspaceKeyCollisionError,
      "belongs to",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
