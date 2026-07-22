import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { join } from "@std/path";
import {
  buildSystemPrompt,
  environmentContext,
  listWorkspaceFiles,
} from "./prompt.ts";

const scrub = async (tmp: string) => {
  try {
    await Deno.remove(tmp, { recursive: true });
  } catch {
    // best-effort cleanup of the tempdir
  }
};

Deno.test("buildSystemPrompt: renders <environment_context> block", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const prompt = await buildSystemPrompt(tmp);
    assertEquals(prompt.includes("<environment_context>"), true);
    assertEquals(prompt.includes(`<cwd>${tmp}</cwd>`), true);
    assertEquals(prompt.includes("<shell>"), true);
    assertEquals(
      prompt.includes(`<current_date>${new Date().toISOString().slice(0, 10)}</current_date>`),
      true,
    );
    assertEquals(prompt.includes("<files"), true);
    assertEquals(prompt.includes("</environment_context>"), true);
    // cwd/date migrated out of the base instructions into the XML block
    assertEquals(prompt.includes("Working directory:"), false);
    assertEquals(prompt.includes("Today's date:"), false);
  } finally {
    await scrub(tmp);
  }
});

Deno.test("listWorkspaceFiles: git ls-files lists tracked paths", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(tmp, "a.ts"), "x");
    await Deno.mkdir(join(tmp, "dir"));
    await Deno.writeTextFile(join(tmp, "dir", "b.ts"), "y");
    // Skip if git is unavailable or repo init fails — the walk-fallback test
    // below covers the no-git path independently.
    let gitOk = false;
    try {
      const init = await new Deno.Command("git", {
        args: ["init"],
        cwd: tmp,
        stdout: "null",
        stderr: "null",
      }).output();
      gitOk = init.success;
      if (gitOk) {
        const add = await new Deno.Command("git", {
          args: ["add", "-A"],
          cwd: tmp,
          stdout: "null",
          stderr: "null",
        }).output();
        gitOk = add.success;
      }
    } catch {
      gitOk = false;
    }
    if (!gitOk) return;

    const listing = await listWorkspaceFiles(tmp);
    assertEquals(listing.paths.includes("a.ts"), true);
    assertEquals(listing.paths.includes("dir/b.ts"), true);
    assertEquals(listing.paths.some((p) => p.startsWith(".git")), false);
  } finally {
    await scrub(tmp);
  }
});

Deno.test("listWorkspaceFiles: walk fallback skips node_modules and .git", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    // Fresh tempdir is not a git repo and lives outside any repo, so git
    // ls-files fails and the bounded walker runs.
    await Deno.mkdir(join(tmp, "src"));
    await Deno.writeTextFile(join(tmp, "src", "a.ts"), "x");
    await Deno.mkdir(join(tmp, "node_modules"));
    await Deno.writeTextFile(join(tmp, "node_modules", "x.js"), "y");
    await Deno.mkdir(join(tmp, ".hidden"), { recursive: true });
    await Deno.writeTextFile(join(tmp, ".hidden", "secret"), "z");
    await Deno.writeTextFile(join(tmp, "root.ts"), "r");

    const listing = await listWorkspaceFiles(tmp);
    assertEquals(listing.paths.includes("src/a.ts"), true);
    assertEquals(listing.paths.includes("root.ts"), true);
    assertEquals(listing.paths.some((p) => p.startsWith("node_modules")), false);
    // .hidden is a dot-directory → pruned
    assertEquals(listing.paths.some((p) => p.startsWith(".hidden")), false);
  } finally {
    await scrub(tmp);
  }
});

Deno.test("listWorkspaceFiles: walk fallback skips build/out/coverage", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    // Fresh tempdir → git ls-files fails, bounded walker runs. Mirror the
    // node_modules/.hidden test above but for the codex NOISY_DIR_NAMES-derived
    // build-output dirs added to SKIP_DIRS.
    await Deno.mkdir(join(tmp, "src"));
    await Deno.writeTextFile(join(tmp, "src", "a.ts"), "x");
    for (const dir of ["build", "out", "coverage"]) {
      await Deno.mkdir(join(tmp, dir));
      await Deno.writeTextFile(join(tmp, dir, "gen.js"), "g");
    }
    await Deno.writeTextFile(join(tmp, "root.ts"), "r");

    const listing = await listWorkspaceFiles(tmp);
    assertEquals(listing.paths.includes("src/a.ts"), true);
    assertEquals(listing.paths.includes("root.ts"), true);
    for (const dir of ["build", "out", "coverage"]) {
      assertEquals(listing.paths.some((p) => p.startsWith(`${dir}/`)), false);
    }
  } finally {
    await scrub(tmp);
  }
});

Deno.test("listWorkspaceFiles: caps at 200 paths and sets truncated", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    // Fresh tempdir → walk fallback exercises the cap.
    for (let i = 0; i < 210; i++) {
      await Deno.writeTextFile(join(tmp, `f${String(i).padStart(3, "0")}.ts`), "x");
    }
    const listing = await listWorkspaceFiles(tmp);
    assertEquals(listing.paths.length <= 200, true);
    assertEquals(listing.total > 200, true);
    assertEquals(listing.truncated, true);
  } finally {
    await scrub(tmp);
  }
});

Deno.test("listWorkspaceFiles: no truncation under the cap", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    for (let i = 0; i < 5; i++) {
      await Deno.writeTextFile(join(tmp, `f${i}.ts`), "x");
    }
    const listing = await listWorkspaceFiles(tmp);
    assertEquals(listing.paths.length, 5);
    assertEquals(listing.total, 5);
    assertEquals(listing.truncated, false);
  } finally {
    await scrub(tmp);
  }
});

Deno.test("environmentContext: renders count and truncated attributes", () => {
  const block = environmentContext("/tmp/ws", {
    paths: ["a.ts", "b.ts"],
    total: 5,
    truncated: true,
  });
  assertEquals(block.includes('<files count="5" truncated="true">'), true);
  assertEquals(block.includes("a.ts"), true);
  assertEquals(block.includes("b.ts"), true);
});

Deno.test("buildSystemPrompt: still appends AGENTS.md (regression)", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(tmp, "AGENTS.md"), "# Rules\n\nbe concise and kind");
    const prompt = await buildSystemPrompt(tmp);
    assertEquals(prompt.includes("AGENTS.md"), true);
    assertEquals(prompt.includes("be concise and kind"), true);
    // environment block still present alongside AGENTS.md
    assertEquals(prompt.includes("<environment_context>"), true);
  } finally {
    await scrub(tmp);
  }
});
