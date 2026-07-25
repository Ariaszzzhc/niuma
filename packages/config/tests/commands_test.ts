import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  expandCommandTemplate,
  loadCommands,
  parseCommandFile,
} from "../mod.ts";

// ---------------------------------------------------------------------------
// parseCommandFile
// ---------------------------------------------------------------------------

Deno.test("parseCommandFile: no frontmatter — whole file is the template", () => {
  const def = parseCommandFile(
    "Review this code.",
    "review",
    "user",
    "/x/review.md",
  );
  assertEquals(def.name, "review");
  assertEquals(def.template, "Review this code.");
  assertEquals(def.description, undefined);
  assertEquals(def.argumentHint, undefined);
  assertEquals(def.source, "user");
});

Deno.test("parseCommandFile: frontmatter description + argument-hint", () => {
  const text = [
    "---",
    "description: Review a file",
    "argument-hint: <file>",
    "---",
    "",
    "Please review $ARGUMENTS carefully.",
  ].join("\n");
  const def = parseCommandFile(text, "review", "project", "/x/review.md");
  assertEquals(def.description, "Review a file");
  assertEquals(def.argumentHint, "<file>");
  assertEquals(def.template, "Please review $ARGUMENTS carefully.");
});

Deno.test("parseCommandFile: argument_hint underscore alias is accepted", () => {
  const text = "---\nargument_hint: <x>\n---\nbody";
  const def = parseCommandFile(text, "c", "user", "/x/c.md");
  assertEquals(def.argumentHint, "<x>");
  assertEquals(def.template, "body");
});

Deno.test("parseCommandFile: unknown frontmatter keys are tolerated", () => {
  const text = "---\ndescription: d\nmodel: gpt-5\n---\nbody";
  const def = parseCommandFile(text, "c", "user", "/x/c.md");
  assertEquals(def.description, "d");
  assertEquals(def.template, "body");
});

Deno.test("parseCommandFile: unterminated --- is not frontmatter", () => {
  const text = "---\nnot really frontmatter\njust markdown";
  const def = parseCommandFile(text, "c", "user", "/x/c.md");
  assertEquals(def.description, undefined);
  assertEquals(def.template, text.trim());
});

Deno.test("parseCommandFile: markdown hr after content is not frontmatter", () => {
  const text = "---\nthis line has no colon\n---\nbody";
  const def = parseCommandFile(text, "c", "user", "/x/c.md");
  assertEquals(def.description, undefined);
  assertEquals(def.template, text.trim());
});

// ---------------------------------------------------------------------------
// expandCommandTemplate
// ---------------------------------------------------------------------------

Deno.test("expandCommandTemplate: $ARGUMENTS replaced verbatim", () => {
  assertEquals(
    expandCommandTemplate("Review $ARGUMENTS now.", "src/foo.ts --deep"),
    "Review src/foo.ts --deep now.",
  );
});

Deno.test("expandCommandTemplate: positional $1..$N", () => {
  assertEquals(
    expandCommandTemplate("compare $1 with $2", "a b"),
    "compare a with b",
  );
});

Deno.test("expandCommandTemplate: highest placeholder swallows the rest", () => {
  assertEquals(
    expandCommandTemplate("ask $1 about $2", "bob the quick brown fox"),
    "ask bob about the quick brown fox",
  );
});

Deno.test("expandCommandTemplate: missing positional expands to empty", () => {
  assertEquals(expandCommandTemplate("go $1 then $2", "only"), "go only then ");
});

Deno.test("expandCommandTemplate: quoted args group and unquote", () => {
  assertEquals(
    expandCommandTemplate("say $1", '"hello world"'),
    "say hello world",
  );
});

Deno.test("expandCommandTemplate: no placeholders — args appended", () => {
  assertEquals(
    expandCommandTemplate("Summarize.", "src/a.ts src/b.ts"),
    "Summarize.\n\nsrc/a.ts src/b.ts",
  );
});

Deno.test("expandCommandTemplate: no placeholders and no args — unchanged", () => {
  assertEquals(expandCommandTemplate("Summarize.", ""), "Summarize.");
  assertEquals(expandCommandTemplate("Summarize.", "   "), "Summarize.");
});

Deno.test("expandCommandTemplate: $ARGUMENTS with no args collapses", () => {
  assertEquals(expandCommandTemplate("Do $ARGUMENTS!", ""), "Do !");
});

// ---------------------------------------------------------------------------
// loadCommands
// ---------------------------------------------------------------------------

const withTempDirs = async (
  fn: (dirs: { global: string; ws: string }) => Promise<void>,
): Promise<void> => {
  const global = await Deno.makeTempDir();
  const ws = await Deno.makeTempDir();
  try {
    await fn({ global, ws });
  } finally {
    await Deno.remove(global, { recursive: true });
    await Deno.remove(ws, { recursive: true });
  }
};

const writeCommand = async (
  dir: string,
  name: string,
  text: string,
): Promise<void> => {
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(join(dir, `${name}.md`), text);
};

Deno.test("loadCommands: missing dirs yield an empty table", async () => {
  await withTempDirs(async ({ global, ws }) => {
    const table = await loadCommands({
      globalConfigDir: global,
      workspace: ws,
    });
    assertEquals(table.size, 0);
  });
});

Deno.test("loadCommands: global + project dirs merge, project wins", async () => {
  await withTempDirs(async ({ global, ws }) => {
    await writeCommand(join(global, "commands"), "shared", "global version");
    await writeCommand(join(global, "commands"), "onlyglobal", "g");
    await writeCommand(
      join(ws, ".niuma", "commands"),
      "shared",
      "project version",
    );
    await writeCommand(join(ws, ".niuma", "commands"), "onlyproj", "p");

    const table = await loadCommands({
      globalConfigDir: global,
      workspace: ws,
    });
    assertEquals(table.get("shared")?.template, "project version");
    assertEquals(table.get("shared")?.source, "project");
    assertEquals(table.get("onlyglobal")?.template, "g");
    assertEquals(table.get("onlyproj")?.template, "p");
    assertEquals(table.size, 3);
  });
});

Deno.test("loadCommands: closer project dir wins over a shallower one", async () => {
  const base = await Deno.makeTempDir();
  try {
    const nested = join(base, "a", "b");
    await Deno.mkdir(nested, { recursive: true });
    await writeCommand(join(base, ".niuma", "commands"), "c", "shallow");
    await writeCommand(join(base, "a", ".niuma", "commands"), "c", "deep");

    const table = await loadCommands({
      globalConfigDir: base,
      workspace: nested,
    });
    assertEquals(table.get("c")?.template, "deep");
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("loadCommands: name comes from the filename, not frontmatter", async () => {
  await withTempDirs(async ({ global, ws }) => {
    await writeCommand(
      join(global, "commands"),
      "file-name",
      "---\ndescription: d\n---\nbody",
    );
    const table = await loadCommands({
      globalConfigDir: global,
      workspace: ws,
    });
    assertEquals(table.get("file-name")?.name, "file-name");
    assertEquals(table.get("file-name")?.description, "d");
  });
});
