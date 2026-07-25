import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  BUILTIN_PROVIDERS,
  builtinBaseUrlFor,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT,
  defaultModelRef,
  KIMI_API_BASE_URL,
  KIMI_PROVIDER_ID,
  parseConfig,
  resolveModelRef,
  resolveProvider,
} from "../mod.ts";

// Built-in provider tests: login-and-go resolution (no [provider.*] table),
// the user-overlay merge (user fields win), the metadata fallback chain, and
// the default-model-ref fallback used when config `model` is unset.

const EMPTY = parseConfig("");

Deno.test("resolveProvider: built-in kimi resolves with no user table", () => {
  const p = resolveProvider(EMPTY, KIMI_PROVIDER_ID);
  assertEquals(p?.type, "openai");
  assertEquals(p?.baseUrl, KIMI_API_BASE_URL);
  assertEquals(
    p?.models["kimi-for-coding"],
    BUILTIN_PROVIDERS[KIMI_PROVIDER_ID]!.models["kimi-for-coding"]!,
  );
});

Deno.test("resolveProvider: user table overlays the built-in, user fields win", () => {
  const config = parseConfig(`
    [provider.kimi]
    base_url = "https://proxy.example/v1"
    [provider.kimi.models.kimi-for-coding]
    context_window = 100000
    max_output = 4096
    [provider.kimi.models.custom-model]
    context_window = 64000
    max_output = 2048
  `);
  const p = resolveProvider(config, KIMI_PROVIDER_ID)!;
  // User scalar wins; built-in type survives (user table did not set it).
  assertEquals(p.baseUrl, "https://proxy.example/v1");
  assertEquals(p.type, "openai");
  // Per-model merge: user's declared model wins, user's extra model is kept.
  assertEquals(p.models["kimi-for-coding"], {
    contextWindow: 100000,
    maxOutput: 4096,
  });
  assertEquals(p.models["custom-model"], {
    contextWindow: 64000,
    maxOutput: 2048,
  });
});

Deno.test("resolveProvider: non-built-in ids pass through; unknown ids are undefined", () => {
  const config = parseConfig(`
    [provider.deepseek]
    base_url = "https://api.deepseek.com/v1"
  `);
  assertEquals(resolveProvider(config, "deepseek"), config.providers.deepseek);
  assertEquals(resolveProvider(EMPTY, "nope"), undefined);
});

Deno.test("resolveModelRef: built-in kimi needs no provider table; metadata comes from the fallback table", () => {
  const resolved = resolveModelRef(EMPTY, "kimi/kimi-for-coding");
  assertEquals(resolved.provider.baseUrl, KIMI_API_BASE_URL);
  assertEquals(resolved.modelId, "kimi-for-coding");
  assertEquals(resolved.model.contextWindow, 262_144);
  assertEquals(resolved.model.maxOutput, DEFAULT_MAX_OUTPUT);
});

Deno.test("resolveModelRef: undeclared model on a built-in gets the global default limits", () => {
  const resolved = resolveModelRef(EMPTY, "kimi/some-future-model");
  assertEquals(resolved.model.contextWindow, DEFAULT_CONTEXT_WINDOW);
  assertEquals(resolved.model.maxOutput, DEFAULT_MAX_OUTPUT);
});

Deno.test("resolveModelRef: unknown provider error names the built-ins as available", async () => {
  const err = await assertRejects(
    () => Promise.resolve().then(() => resolveModelRef(EMPTY, "nope/m")),
    Error,
    "not configured",
  );
  assertStringIncludes(err.message, "kimi");
  assertStringIncludes(err.message, "openai");
});

Deno.test("defaultModelRef: the unique logged-in built-in provides the ref (credential-kind aware)", () => {
  assertEquals(defaultModelRef(() => undefined), undefined);
  const apiEntry = { type: "api", key: "k" } as const;
  const oauthEntry = {
    type: "oauth",
    refresh: "r",
    access: "a",
    expires: 0,
  } as const;
  // Kimi API key → open-platform default model; Kimi OAuth → subscription.
  assertEquals(
    defaultModelRef((id) => id === "kimi" ? apiEntry : undefined),
    "kimi/kimi-k2.7-code",
  );
  assertEquals(
    defaultModelRef((id) => id === "kimi" ? oauthEntry : undefined),
    "kimi/kimi-for-coding",
  );
  assertEquals(
    defaultModelRef((id) => id === "openai" ? oauthEntry : undefined),
    `openai/${BUILTIN_PROVIDERS.openai!.defaultModel}`,
  );
  // Both logged in → ambiguous → undefined (the caller keeps its error).
  assertEquals(defaultModelRef(() => oauthEntry), undefined);
});

Deno.test("builtinBaseUrlFor: kimi api lane targets the open platform; user override wins", () => {
  const sub = "https://api.kimi.com/coding/v1";
  // OAuth lane keeps the subscription endpoint.
  assertEquals(builtinBaseUrlFor("kimi", "oauth", sub), sub);
  // API-key lane retargets to the open platform.
  assertEquals(
    builtinBaseUrlFor("kimi", "api", sub),
    "https://api.moonshot.cn/v1",
  );
  // A user base_url override beats both lanes.
  assertEquals(
    builtinBaseUrlFor("kimi", "api", sub, "https://proxy.example/v1"),
    "https://proxy.example/v1",
  );
  // Every other provider is the identity.
  assertEquals(builtinBaseUrlFor("deepseek", "api", "https://d"), "https://d");
});
