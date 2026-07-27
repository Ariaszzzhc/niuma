import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  getAuth,
  readAuthFile,
  removeAuth,
  setAuth,
  writeAuthFile,
} from "../mod.ts";

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

Deno.test("readAuthFile: malformed JSON is deleted", async () => {
  await withTempFile(async (path) => {
    await Deno.writeTextFile(path, "{not json");
    assertEquals(await readAuthFile(path), {});
    await assertRejects(() => Deno.stat(path), Deno.errors.NotFound);
  });
});

Deno.test("readAuthFile: deletes unrecognised entries and preserves valid ones", async () => {
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
    assertEquals(JSON.parse(await Deno.readTextFile(path)), {
      good: { type: "api", key: "sk-1" },
    });
  });
});

Deno.test("readAuthFile: keeps valid oauth entries, drops malformed ones", async () => {
  await withTempFile(async (path) => {
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        // A well-formed oauth entry survives.
        ok: {
          type: "oauth",
          refresh: "rt-1",
          access: "at-1",
          expires: 1735689600000,
          accountId: "acct-1",
        },
        // Missing access/refresh — dropped.
        missing_fields: { type: "oauth", refresh: "rt" },
        // Non-numeric expires — dropped.
        bad_expires: {
          type: "oauth",
          refresh: "rt",
          access: "at",
          expires: "soon",
        },
        // Non-string accountId — dropped.
        bad_account: {
          type: "oauth",
          refresh: "rt",
          access: "at",
          expires: 1,
          accountId: 42,
        },
        // accountId omitted entirely — still valid.
        no_account: {
          type: "oauth",
          refresh: "rt-2",
          access: "at-2",
          expires: 1,
        },
        // A recognised api entry next to a junk oauth one survives.
        api: { type: "api", key: "sk-2" },
      }),
    );
    assertEquals(await readAuthFile(path), {
      ok: {
        type: "oauth",
        refresh: "rt-1",
        access: "at-1",
        expires: 1735689600000,
        accountId: "acct-1",
      },
      no_account: {
        type: "oauth",
        refresh: "rt-2",
        access: "at-2",
        expires: 1,
      },
      api: { type: "api", key: "sk-2" },
    });
    assertEquals(Object.keys(JSON.parse(await Deno.readTextFile(path))), [
      "ok",
      "no_account",
      "api",
    ]);
  });
});

Deno.test("readAuthFile: a valid oauth entry with accountId absent is stored without the key", async () => {
  // accountId must be omitted (not null/undefined) so exactOptionalPropertyTypes
  // round-trips cleanly through writeAuthFile.
  await withTempFile(async (path) => {
    await writeAuthFile(path, {
      x: { type: "oauth", refresh: "r", access: "a", expires: 7 },
    });
    const raw = JSON.parse(await Deno.readTextFile(path));
    assertEquals(Object.keys(raw.x), ["type", "refresh", "access", "expires"]);
    assertEquals(await readAuthFile(path), {
      x: { type: "oauth", refresh: "r", access: "a", expires: 7 },
    });
  });
});

Deno.test("readAuthFile: stray fields on an otherwise-valid entry are stripped", async () => {
  await withTempFile(async (path) => {
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        api: { type: "api", key: "k", extra: "drop-me" },
        oauth: {
          type: "oauth",
          refresh: "r",
          access: "a",
          expires: 9,
          junk: 123,
        },
      }),
    );
    assertEquals(await readAuthFile(path), {
      api: { type: "api", key: "k" },
      oauth: { type: "oauth", refresh: "r", access: "a", expires: 9 },
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
    assertEquals(await getAuth(path, "deepseek"), {
      type: "api",
      key: "sk-a2",
    });
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

Deno.test("setAuth: normalizes stray fields and explicit undefined on the WRITE path", async () => {
  // The read path strips strays (see the "stray fields ... stripped" test
  // above); the write path must enforce the same invariant so a caller that
  // assembles an AuthInfo loosely (extra keys, or an explicit
  // accountId: undefined) cannot pollute the 0600 file — which would
  // otherwise survive on disk until the next read strips them.
  await withTempFile(async (path) => {
    // Smuggle a stray key + an explicit undefined past the type checker
    // (mirrors a caller that built the object from a loose record).
    const loose = {
      type: "oauth",
      refresh: "r",
      access: "a",
      expires: 1_700_000_000_000,
      accountId: undefined,
      junk: "drop-me",
    } as unknown as Parameters<typeof setAuth>[2];
    await setAuth(path, "openai", loose);
    const raw = JSON.parse(await Deno.readTextFile(path));
    assertEquals(
      (Object.keys(raw.openai) as string[]).sort(),
      ["access", "expires", "refresh", "type"],
    );
    assertEquals("junk" in raw.openai, false);
    assertEquals("accountId" in raw.openai, false);
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

Deno.test("setAuth/getAuth/removeAuth: oauth credentials round-trip and stay 0600", async () => {
  await withTempFile(async (path) => {
    const oauth = {
      type: "oauth" as const,
      refresh: "rt-old",
      access: "at-old",
      expires: 1_700_000_000_000,
      accountId: "acct-xyz",
    };
    await setAuth(path, "openai", oauth);
    assertEquals(await getAuth(path, "openai"), oauth);

    // An api entry coexisting in the same file is untouched.
    await setAuth(path, "deepseek", { type: "api", key: "sk-1" });

    // Overwrite the oauth entry with refreshed tokens (and no accountId).
    const refreshed = {
      type: "oauth" as const,
      refresh: "rt-new",
      access: "at-new",
      expires: 1_700_000_001_000,
    };
    await setAuth(path, "openai", refreshed);
    assertEquals(await getAuth(path, "openai"), refreshed);
    assertEquals(await getAuth(path, "deepseek"), { type: "api", key: "sk-1" });

    if (Deno.build.os !== "windows") {
      const info = await Deno.stat(path);
      assertEquals(info.mode! & 0o777, 0o600);
    }

    await removeAuth(path, "openai");
    assertEquals(await getAuth(path, "openai"), undefined);
    assertEquals(await getAuth(path, "deepseek"), { type: "api", key: "sk-1" });
  });
});

// ----- additional edge cases ------------------------------------------------

Deno.test("readAuthFile: JSON array root is deleted", async () => {
  await withTempFile(async (path) => {
    await Deno.writeTextFile(path, "[1, 2, 3]");
    assertEquals(await readAuthFile(path), {});
    await assertRejects(() => Deno.stat(path), Deno.errors.NotFound);
  });
});

Deno.test("readAuthFile: JSON scalar root is deleted", async () => {
  await withTempFile(async (path) => {
    await Deno.writeTextFile(path, "42");
    assertEquals(await readAuthFile(path), {});
    await assertRejects(() => Deno.stat(path), Deno.errors.NotFound);
  });
});

Deno.test("readAuthFile: getAuth returns undefined for a missing provider id", async () => {
  await withTempFile(async (path) => {
    await writeAuthFile(path, { openai: { type: "api", key: "k" } });
    assertEquals(await getAuth(path, "anthropic"), undefined);
  });
});

Deno.test("readAuthFile: api entry with a non-string key is dropped", async () => {
  await withTempFile(async (path) => {
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        // type:"api" but `key` is the wrong shape; the receiver must drop it.
        bad: { type: "api", key: 42 },
        good: { type: "api", key: "sk-1" },
      }),
    );
    assertEquals(await readAuthFile(path), {
      good: { type: "api", key: "sk-1" },
    });
  });
});

Deno.test("readAuthFile: oauth entry with NaN/Infinity expires is dropped", async () => {
  await withTempFile(async (path) => {
    // JSON serializes NaN as null, so we craft raw JSON for the pathological
    // cases. The narrowing must refuse non-finite numeric expires.
    await Deno.writeTextFile(
      path,
      `{"nan": {"type": "oauth", "refresh": "r", "access": "a", "expires": null}}`,
    );
    assertEquals(await readAuthFile(path), {});
  });
});

Deno.test("readAuthFile: oauth entry with a non-string refresh/access is dropped", async () => {
  await withTempFile(async (path) => {
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        bad_refresh: { type: "oauth", refresh: 42, access: "a", expires: 1 },
        bad_access: { type: "oauth", refresh: "r", access: null, expires: 1 },
      }),
    );
    assertEquals(await readAuthFile(path), {});
  });
});

Deno.test("readAuthFile: unknown type value is dropped (no false-positive match)", async () => {
  await withTempFile(async (path) => {
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        weird: { type: "service-account", token: "x" },
        no_type: { key: "k" },
      }),
    );
    assertEquals(await readAuthFile(path), {});
  });
});

Deno.test("setAuth: overwriting an oauth entry with an api entry keeps the file 0600", async () => {
  await withTempFile(async (path) => {
    await setAuth(path, "openai", {
      type: "oauth",
      refresh: "r",
      access: "a",
      expires: 1,
    });
    await setAuth(path, "openai", { type: "api", key: "sk-1" });
    assertEquals(await getAuth(path, "openai"), { type: "api", key: "sk-1" });
    if (Deno.build.os !== "windows") {
      assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
    }
  });
});

Deno.test("setAuth: first setAuth on a brand-new file creates a 0600 file", async () => {
  await withTempFile(async (path) => {
    await setAuth(path, "openai", { type: "api", key: "k" });
    // File must exist and the read round-trip must be the input.
    assertEquals(await getAuth(path, "openai"), { type: "api", key: "k" });
    if (Deno.build.os !== "windows") {
      assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
    }
  });
});

Deno.test("removeAuth: removing a missing key is a no-op that does not corrupt the file", async () => {
  await withTempFile(async (path) => {
    await writeAuthFile(path, {
      openai: { type: "oauth", refresh: "r", access: "a", expires: 1 },
    });
    await removeAuth(path, "does-not-exist");
    assertEquals(await getAuth(path, "openai"), {
      type: "oauth",
      refresh: "r",
      access: "a",
      expires: 1,
    });
  });
});

Deno.test("writeAuthFile: writing an empty map round-trips to an empty map", async () => {
  await withTempFile(async (path) => {
    await writeAuthFile(path, {});
    assertEquals(await readAuthFile(path), {});
  });
});

Deno.test("readAuthFile: oauth accountId=undefined is omitted from the JSON on disk", async () => {
  // exactOptionalPropertyTypes: when the caller passes no accountId, the
  // on-disk JSON must NOT carry the key. Round-trip via setAuth so the
  // normalize() path runs.
  await withTempFile(async (path) => {
    await setAuth(path, "openai", {
      type: "oauth",
      refresh: "r",
      access: "a",
      expires: 1_700_000_000_000,
    });
    const raw = JSON.parse(await Deno.readTextFile(path));
    assertEquals(Object.keys(raw.openai), [
      "type",
      "refresh",
      "access",
      "expires",
    ]);
    assertEquals("accountId" in raw.openai, false);
  });
});

Deno.test("readAuthFile: mixed api+oauth map with both keys preserved", async () => {
  await withTempFile(async (path) => {
    await writeAuthFile(path, {
      deepseek: { type: "api", key: "sk-d" },
      openai: {
        type: "oauth",
        refresh: "rt",
        access: "at",
        expires: 1_700_000_000_000,
        accountId: "acct-1",
      },
      anthropic: { type: "api", key: "sk-a" },
    });
    assertEquals(await readAuthFile(path), {
      deepseek: { type: "api", key: "sk-d" },
      openai: {
        type: "oauth",
        refresh: "rt",
        access: "at",
        expires: 1_700_000_000_000,
        accountId: "acct-1",
      },
      anthropic: { type: "api", key: "sk-a" },
    });
  });
});
