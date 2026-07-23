import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { join } from "@std/path";
import { getAuth, readAuthFile, removeAuth, setAuth, writeAuthFile } from "../mod.ts";

const withTempFile = async (
  fn: (path: string) => Promise<void>,
): Promise<void> => {
  const dir = await Deno.makeTempDir();
  try {
    await fn(join(dir, "auth.json"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

Deno.test("readAuthFile: missing file is an empty map", async () => {
  await withTempFile(async (path) => {
    assertEquals(await readAuthFile(path), {});
  });
});

Deno.test("readAuthFile: malformed JSON is an empty map", async () => {
  await withTempFile(async (path) => {
    await Deno.writeTextFile(path, "{not json");
    assertEquals(await readAuthFile(path), {});
  });
});

Deno.test("readAuthFile: drops unrecognised entries, keeps valid ones", async () => {
  await withTempFile(async (path) => {
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        good: { type: "api", key: "sk-1" },
        bad: { type: "oauth", token: "x" },
        worse: 42,
      }),
    );
    assertEquals(await readAuthFile(path), {
      good: { type: "api", key: "sk-1" },
    });
  });
});

Deno.test("setAuth/getAuth/removeAuth round-trip with 0600 mode", async () => {
  await withTempFile(async (path) => {
    await setAuth(path, "deepseek", { type: "api", key: "sk-a" });
    await setAuth(path, "openai", { type: "api", key: "sk-b" });
    assertEquals(await getAuth(path, "deepseek"), { type: "api", key: "sk-a" });
    assertEquals(await getAuth(path, "openai"), { type: "api", key: "sk-b" });

    // Overwrite one without disturbing the other.
    await setAuth(path, "deepseek", { type: "api", key: "sk-a2" });
    assertEquals(await getAuth(path, "deepseek"), { type: "api", key: "sk-a2" });
    assertEquals(await getAuth(path, "openai"), { type: "api", key: "sk-b" });

    if (Deno.build.os !== "windows") {
      const info = await Deno.stat(path);
      assertEquals(info.mode! & 0o777, 0o600);
    }

    await removeAuth(path, "deepseek");
    assertEquals(await getAuth(path, "deepseek"), undefined);
    assertEquals(await getAuth(path, "openai"), { type: "api", key: "sk-b" });
  });
});

Deno.test("writeAuthFile: writes 0600 from the start", async () => {
  await withTempFile(async (path) => {
    await writeAuthFile(path, { p: { type: "api", key: "k" } });
    if (Deno.build.os !== "windows") {
      const info = await Deno.stat(path);
      assertEquals(info.mode! & 0o777, 0o600);
    }
    assertEquals(await readAuthFile(path), { p: { type: "api", key: "k" } });
  });
});
