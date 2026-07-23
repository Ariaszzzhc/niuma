import { assertEquals, assertThrows } from "jsr:@std/assert@^1.0.0";
import { join } from "@std/path";
import {
  loadConfigFile,
  loadMergedConfig,
  mergeConfig,
  parseConfig,
  parseModelRef,
  resolveModelRef,
  substituteEnv,
} from "../mod.ts";
import { ConfigError } from "../src/config.ts";

Deno.test("parseConfig: empty text yields defaults", () => {
  const c = parseConfig("");
  assertEquals(c.model, undefined);
  // Unset, NOT "info": the fallback lives in consumers, so a project-level
  // file can override the global one in mergeConfig.
  assertEquals(c.core.logLevel, undefined);
  assertEquals(c.providers, {});
});

Deno.test("parseConfig: full document", () => {
  const c = parseConfig(`
model = "deepseek/deepseek-chat"

[core]
log_level = "debug"

[provider.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/v1/"

[provider.deepseek.models.deepseek-chat]
context_window = 128000
max_output = 8192
`);
  assertEquals(c.model, "deepseek/deepseek-chat");
  assertEquals(c.core.logLevel, "debug");
  const p = c.providers.deepseek!;
  assertEquals(p.name, "DeepSeek");
  // trailing slashes trimmed
  assertEquals(p.baseUrl, "https://api.deepseek.com/v1");
  assertEquals(p.models["deepseek-chat"], {
    contextWindow: 128000,
    maxOutput: 8192,
  });
});

Deno.test("parseConfig: provider without base_url parses (partial table), resolveModelRef rejects it", () => {
  const c = parseConfig(`[provider.x]`);
  assertEquals(c.providers.x!.baseUrl, undefined);
  assertThrows(
    () => resolveModelRef(c, "x/m"),
    ConfigError,
    'provider "x" has no base_url',
  );
});

Deno.test("parseConfig: wrong field types are rejected", () => {
  assertThrows(
    () =>
      parseConfig(`
[provider.x]
base_url = "https://x"
[provider.x.models.m]
context_window = "128k"
`),
    ConfigError,
    "positive integer",
  );
  assertThrows(
    () => parseConfig(`[core]\nlog_level = "chatty"`),
    ConfigError,
    "log_level",
  );
  assertThrows(() => parseConfig(`model = 3`), ConfigError, "string");
});

Deno.test("parseConfig: undeclared model gets default limits", () => {
  const c = parseConfig(`
[provider.x]
base_url = "https://x"
`);
  const r = resolveModelRef(c, "x/whatever");
  assertEquals(r.model.contextWindow, 200_000);
  assertEquals(r.model.maxOutput, 16_384);
});

Deno.test("parseModelRef: provider/model-id, model id may contain slashes", () => {
  assertEquals(parseModelRef("openai/gpt-5-mini"), {
    providerId: "openai",
    modelId: "gpt-5-mini",
  });
  assertEquals(parseModelRef("openrouter/anthropic/claude-sonnet"), {
    providerId: "openrouter",
    modelId: "anthropic/claude-sonnet",
  });
  assertThrows(() => parseModelRef("no-slash"), ConfigError, "provider/model-id");
  assertThrows(() => parseModelRef("/model"), ConfigError);
  assertThrows(() => parseModelRef("provider/"), ConfigError);
});

Deno.test("resolveModelRef: unknown provider names the configured ones", () => {
  const c = parseConfig(`
[provider.a]
base_url = "https://a"
`);
  assertThrows(
    () => resolveModelRef(c, "b/m"),
    ConfigError,
    'provider "b" is not configured (configured: a)',
  );
});

Deno.test("substituteEnv: replaces {env:VAR}, leaves unknown intact", () => {
  Deno.env.set("NIUMA_TEST_SUB", "hello");
  try {
    assertEquals(substituteEnv("{env:NIUMA_TEST_SUB}"), "hello");
    assertEquals(
      substituteEnv("prefix-{env:NIUMA_TEST_SUB}-suffix"),
      "prefix-hello-suffix",
    );
    assertEquals(
      substituteEnv("{env:NIUMA_TEST_MISSING_VAR}"),
      "{env:NIUMA_TEST_MISSING_VAR}",
    );
  } finally {
    Deno.env.delete("NIUMA_TEST_SUB");
  }
});

Deno.test("loadConfigFile: missing file yields empty config", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const c = await loadConfigFile(join(dir, "nope.toml"));
    assertEquals(c.providers, {});
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadConfigFile: reads and parses a real file", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = join(dir, "config.toml");
    await Deno.writeTextFile(
      file,
      `model = "p/m"\n[provider.p]\nbase_url = "https://p"\n`,
    );
    const c = await loadConfigFile(file);
    assertEquals(c.model, "p/m");
    assertEquals(c.providers.p!.baseUrl, "https://p");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mergeConfig: override wins on scalars, providers/models merge per id", () => {
  const base = parseConfig(`
model = "a/m1"

[core]
log_level = "debug"

[provider.a]
base_url = "https://a"
[provider.a.models.m1]
context_window = 100
[provider.a.models.m2]
context_window = 200
max_output = 20
`);
  const override = parseConfig(`
model = "b/m9"

[provider.a.models.m1]
context_window = 111
max_output = 11
[provider.b]
base_url = "https://b"
`);
  const merged = mergeConfig(base, override);
  assertEquals(merged.model, "b/m9");
  // core not set in the override → base survives
  assertEquals(merged.core.logLevel, "debug");
  // per-model merge: m1 overridden, m2 inherited from base
  assertEquals(merged.providers.a!.models.m1, {
    contextWindow: 111,
    maxOutput: 11,
  });
  assertEquals(merged.providers.a!.models.m2, {
    contextWindow: 200,
    maxOutput: 20,
  });
  assertEquals(merged.providers.a!.baseUrl, "https://a");
  assertEquals(merged.providers.b!.baseUrl, "https://b");
});

Deno.test("mergeConfig: empty override is the identity", () => {
  const base = parseConfig(`model = "a/m"\n[provider.a]\nbase_url = "https://a"`);
  assertEquals(mergeConfig(base, parseConfig("")), base);
});

Deno.test("loadMergedConfig: project file overrides the global one", async () => {
  const root = await Deno.makeTempDir();
  try {
    const global = join(root, "config.toml");
    await Deno.writeTextFile(
      global,
      `model = "g/gm"\n[provider.g]\nbase_url = "https://g"\n`,
    );
    const repo = join(root, "repo");
    const pkg = join(repo, "packages", "x");
    await Deno.mkdir(pkg, { recursive: true });
    // Repo-level file re-points the default model at the same provider.
    await Deno.writeTextFile(
      join(repo, "niuma.toml"),
      `model = "g/repo-model"\n`,
    );
    // Package-level file adds model limits only.
    await Deno.writeTextFile(
      join(pkg, "niuma.toml"),
      `[provider.g.models.repo-model]\ncontext_window = 4242\n`,
    );
    const c = await loadMergedConfig(global, { projectDir: pkg });
    // Closest file wins for the scalar, and the deeper file's model table
    // merged into the global provider without restating base_url.
    assertEquals(c.model, "g/repo-model");
    const r = resolveModelRef(c, c.model!);
    assertEquals(r.provider.baseUrl, "https://g");
    assertEquals(r.model.contextWindow, 4242);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("loadMergedConfig: no project files yields the global config", async () => {
  const root = await Deno.makeTempDir();
  try {
    const global = join(root, "config.toml");
    await Deno.writeTextFile(
      global,
      `model = "g/m"\n[provider.g]\nbase_url = "https://g"\n`,
    );
    const ws = join(root, "ws");
    await Deno.mkdir(ws);
    const c = await loadMergedConfig(global, { projectDir: ws });
    assertEquals(c.model, "g/m");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
