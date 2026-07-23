import { assertEquals, assertThrows } from "jsr:@std/assert@^1.0.0";
import { join } from "@std/path";
import {
  loadConfigFile,
  parseConfig,
  parseModelRef,
  resolveModelRef,
  substituteEnv,
} from "../mod.ts";
import { ConfigError } from "../src/config.ts";

Deno.test("parseConfig: empty text yields defaults", () => {
  const c = parseConfig("");
  assertEquals(c.model, undefined);
  assertEquals(c.core.logLevel, "info");
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

Deno.test("parseConfig: provider requires base_url", () => {
  assertThrows(
    () => parseConfig(`[provider.x]`),
    ConfigError,
    "base_url is required",
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
