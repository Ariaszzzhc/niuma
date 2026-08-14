import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  loadSkills,
  parseSkillFile,
  SKILL_BODY_CAP_BYTES,
  SKILL_BODY_TRUNCATED_MARKER,
} from "../mod.ts";

// ---------------------------------------------------------------------------
// parseSkillFile
// ---------------------------------------------------------------------------

Deno.test("parseSkillFile: name + description frontmatter, body preserved", () => {
  const text = [
    "---",
    "name: review",
    "description: Review a file",
    "---",
    "",
    "Please review carefully.",
    "",
    "- step one",
  ].join("\n");
  const def = parseSkillFile(text, "/x/review", "user");
  assert(def !== null);
  assertEquals(def.name, "review");
  assertEquals(def.description, "Review a file");
  assertEquals(def.body, "Please review carefully.\n\n- step one");
  assertEquals(def.dir, "/x/review");
  assertEquals(def.source, "user");
});

Deno.test("parseSkillFile: missing name or description yields null", () => {
  assertEquals(
    parseSkillFile("---\ndescription: d\n---\nbody", "/x/a", "user"),
    null,
  );
  assertEquals(parseSkillFile("---\nname: n\n---\nbody", "/x/a", "user"), null);
  assertEquals(
    parseSkillFile("---\nname: \ndescription: d\n---\nbody", "/x/a", "user"),
    null,
  );
});

Deno.test("parseSkillFile: no frontmatter at all yields null", () => {
  assertEquals(parseSkillFile("Just markdown.", "/x/a", "user"), null);
  // Unterminated --- is not frontmatter (same policy as commands).
  assertEquals(
    parseSkillFile(
      "---\nnot really frontmatter\njust markdown",
      "/x/a",
      "user",
    ),
    null,
  );
});

Deno.test("parseSkillFile: unknown frontmatter keys are tolerated", () => {
  const text = "---\nname: n\ndescription: d\nmodel: gpt-5\n---\nbody";
  const def = parseSkillFile(text, "/x/a", "project");
  assert(def !== null);
  assertEquals(def.name, "n");
  assertEquals(def.body, "body");
  assertEquals(def.source, "project");
});

Deno.test("parseSkillFile: body over 32 KiB is truncated with a marker", () => {
  const big = "x".repeat(SKILL_BODY_CAP_BYTES + 1000);
  const def = parseSkillFile(
    `---\nname: big\ndescription: d\n---\n${big}`,
    "/x/big",
    "user",
  );
  assert(def !== null);
  assert(def.body.endsWith(`\n${SKILL_BODY_TRUNCATED_MARKER}`));
  const bodyBytes = new TextEncoder().encode(def.body).length;
  assert(
    bodyBytes <=
      SKILL_BODY_CAP_BYTES + SKILL_BODY_TRUNCATED_MARKER.length + 2,
    `body byte length ${bodyBytes}`,
  );
});

// ---------------------------------------------------------------------------
// loadSkills
// ---------------------------------------------------------------------------

const withTempDirs = async (
  fn: (dirs: { global: string; agents: string; ws: string }) => Promise<void>,
): Promise<void> => {
  const global = await Deno.makeTempDir();
  const agents = await Deno.makeTempDir();
  const ws = await Deno.makeTempDir();
  try {
    await fn({ global, agents, ws });
  } finally {
    await Deno.remove(global, { recursive: true });
    await Deno.remove(agents, { recursive: true });
    await Deno.remove(ws, { recursive: true });
  }
};

const writeSkill = async (
  dir: string,
  name: string,
  body: string,
): Promise<void> => {
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} desc\n---\n${body}`,
  );
};

Deno.test("loadSkills: missing dirs yield an empty table", async () => {
  await withTempDirs(async ({ global, agents, ws }) => {
    const table = await loadSkills({
      globalConfigDir: global,
      agentsSkillsDir: agents,
      workspace: ws,
    });
    assertEquals(table.size, 0);
  });
});

Deno.test("loadSkills: name comes from frontmatter, not the directory name", async () => {
  await withTempDirs(async ({ global, agents, ws }) => {
    await writeSkill(join(global, "skills", "dir-name"), "real-name", "body");
    const table = await loadSkills({
      globalConfigDir: global,
      agentsSkillsDir: agents,
      workspace: ws,
    });
    assertEquals(table.get("real-name")?.name, "real-name");
    assertEquals(
      table.get("real-name")?.dir,
      join(global, "skills", "dir-name"),
    );
    assertEquals(table.get("real-name")?.source, "user");
    assertEquals(table.has("dir-name"), false);
  });
});

Deno.test("loadSkills: recursive discovery, depth 5 is not found", async () => {
  await withTempDirs(async ({ global, agents, ws }) => {
    await writeSkill(join(global, "skills", "top"), "top", "shallow");
    await writeSkill(
      join(global, "skills", "a", "b", "c", "d"),
      "deep4",
      "depth 4",
    );
    await writeSkill(
      join(global, "skills", "a", "b", "c", "d", "e"),
      "deep5",
      "depth 5",
    );
    const table = await loadSkills({
      globalConfigDir: global,
      agentsSkillsDir: agents,
      workspace: ws,
    });
    assertEquals(table.has("top"), true);
    assertEquals(table.has("deep4"), true);
    assertEquals(table.has("deep5"), false);
  });
});

Deno.test("loadSkills: priority project > ~/.niuma/skills > ~/.agents/skills", async () => {
  await withTempDirs(async ({ global, agents, ws }) => {
    await writeSkill(join(agents, "shared"), "shared", "agents version");
    await writeSkill(
      join(global, "skills", "shared"),
      "shared",
      "niuma version",
    );
    await writeSkill(
      join(ws, ".niuma", "skills", "shared"),
      "shared",
      "project version",
    );
    await writeSkill(join(agents, "only-agents"), "only-agents", "a");

    const table = await loadSkills({
      globalConfigDir: global,
      agentsSkillsDir: agents,
      workspace: ws,
    });
    assertEquals(table.get("shared")?.body, "project version");
    assertEquals(table.get("shared")?.source, "project");
    assertEquals(table.get("only-agents")?.body, "a");
    assertEquals(table.get("only-agents")?.source, "user");
  });
});

Deno.test("loadSkills: ~/.niuma/skills beats ~/.agents/skills", async () => {
  const global = await Deno.makeTempDir();
  const agents = await Deno.makeTempDir();
  const ws = await Deno.makeTempDir();
  try {
    await writeSkill(join(agents, "shared"), "shared", "agents version");
    await writeSkill(
      join(global, "skills", "shared"),
      "shared",
      "niuma version",
    );
    const table = await loadSkills({
      globalConfigDir: global,
      agentsSkillsDir: agents,
      workspace: ws,
    });
    assertEquals(table.get("shared")?.body, "niuma version");
    assertEquals(table.get("shared")?.source, "user");
  } finally {
    await Deno.remove(global, { recursive: true });
    await Deno.remove(agents, { recursive: true });
    await Deno.remove(ws, { recursive: true });
  }
});

Deno.test("loadSkills: closer project dir wins over a shallower one", async () => {
  const base = await Deno.makeTempDir();
  try {
    const nested = join(base, "a", "b");
    await Deno.mkdir(nested, { recursive: true });
    await writeSkill(join(base, ".niuma", "skills", "s"), "s", "shallow");
    await writeSkill(join(base, "a", ".niuma", "skills", "s"), "s", "deep");

    const table = await loadSkills({ workspace: nested });
    assertEquals(table.get("s")?.body, "deep");
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("loadSkills: same-level name conflict resolves path-sorted first", async () => {
  await withTempDirs(async ({ global, agents, ws }) => {
    await writeSkill(join(global, "skills", "aaa"), "dup", "first by path");
    await writeSkill(join(global, "skills", "zzz"), "dup", "second by path");
    const table = await loadSkills({
      globalConfigDir: global,
      agentsSkillsDir: agents,
      workspace: ws,
    });
    assertEquals(table.get("dup")?.body, "first by path");
    assertEquals(table.size, 1);
  });
});

Deno.test("loadSkills: an unreadable file does not sink the rest", async () => {
  await withTempDirs(async ({ global, agents, ws }) => {
    const dir = join(global, "skills", "broken");
    await Deno.mkdir(dir, { recursive: true });
    // Invalid UTF-8 makes Deno.readTextFile throw — the file is skipped.
    await Deno.writeFile(
      join(dir, "SKILL.md"),
      new Uint8Array([0x80, 0x80, 0x80]),
    );
    await writeSkill(join(global, "skills", "ok"), "ok", "fine");
    const table = await loadSkills({
      globalConfigDir: global,
      agentsSkillsDir: agents,
      workspace: ws,
    });
    assertEquals(table.size, 1);
    assertEquals(table.get("ok")?.body, "fine");
  });
});

Deno.test("loadSkills: a skill missing required keys is skipped silently", async () => {
  await withTempDirs(async ({ global, agents, ws }) => {
    const dir = join(global, "skills", "noname");
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      join(dir, "SKILL.md"),
      "---\ndescription: no name here\n---\nbody",
    );
    await writeSkill(join(global, "skills", "ok"), "ok", "fine");
    const table = await loadSkills({
      globalConfigDir: global,
      agentsSkillsDir: agents,
      workspace: ws,
    });
    assertEquals(table.size, 1);
    assertEquals(table.has("ok"), true);
  });
});
