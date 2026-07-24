import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { niumaPaths } from "../mod.ts";

const withEnv = async <T>(
  vars: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> => {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, Deno.env.get(k));
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved.entries()) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
};

Deno.test("niumaPaths: defaults under HOME", async () => {
  await withEnv(
    {
      NIUMA_DATA_DIR: undefined,
      NIUMA_CONFIG: undefined,
      XDG_DATA_HOME: undefined,
      XDG_CONFIG_HOME: undefined,
    },
    () => {
      const home = Deno.env.get("HOME")!;
      const p = niumaPaths();
      // Expectations go through join() so they hold with Windows separators.
      assertEquals(p.data, join(home, ".niuma"));
      assertEquals(p.config, join(home, ".niuma"));
      assertEquals(p.log, join(home, ".niuma", "log"));
      assertEquals(p.authFile, join(home, ".niuma", "auth.json"));
      assertEquals(p.configFile, join(home, ".niuma", "config.toml"));
    },
  );
});

Deno.test("niumaPaths: NIUMA_DATA_DIR keeps the single-root layout", async () => {
  await withEnv(
    { NIUMA_DATA_DIR: "/tmp/niuma-x", NIUMA_CONFIG: undefined },
    () => {
      const p = niumaPaths();
      assertEquals(p.data, "/tmp/niuma-x");
      assertEquals(p.config, "/tmp/niuma-x");
      assertEquals(p.authFile, join("/tmp/niuma-x", "auth.json"));
      assertEquals(p.configFile, join("/tmp/niuma-x", "config.toml"));
    },
  );
});

Deno.test("niumaPaths: NIUMA_CONFIG points at an explicit file", async () => {
  await withEnv(
    { NIUMA_DATA_DIR: undefined, NIUMA_CONFIG: "/tmp/elsewhere/my.toml" },
    () => {
      assertEquals(niumaPaths().configFile, "/tmp/elsewhere/my.toml");
    },
  );
});
