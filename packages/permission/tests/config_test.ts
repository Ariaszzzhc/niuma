import { Effect } from "effect";
import {
  DEFAULT_BUILTINS,
  defaultConfigPath,
  loadUserRules,
  loadUserRulesEffect,
} from "../src/config.ts";
import type { PermissionRule } from "@niuma/schema";

function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(msg ?? `assertEquals: ${a} !== ${b}`);
}
function assert<T>(cond: T, msg?: string): asserts cond {
  if (!cond) throw new Error(msg ?? "assertion failed");
}

const TMP = await Deno.makeTempDir();

async function writeConfig(name: string, body: string): Promise<string> {
  const path = `${TMP}/${name}`;
  await Deno.writeTextFile(path, body);
  return path;
}

Deno.test("config: DEFAULT_BUILTINS is empty (conservative)", () => {
  assertEquals(DEFAULT_BUILTINS.length, 0);
});

Deno.test("config: defaultConfigPath points at ~/.config/niuma/config.json", () => {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
  if (home.length === 0) return;
  assertEquals(defaultConfigPath(), home + "/.config/niuma/config.json");
});

Deno.test("config: missing file → []", async () => {
  const out = await loadUserRules(`${TMP}/does-not-exist.json`);
  assertEquals(out, []);
});

Deno.test("config: malformed JSON → []", async () => {
  const path = await writeConfig("malformed.json", "{ not json");
  const out = await loadUserRules(path);
  assertEquals(out, []);
});

Deno.test("config: well-formed but schema-invalid → []", async () => {
  // `permissions` must be an array; an object fails the schema and falls back
  // to the empty list rather than throwing.
  const path = await writeConfig("badschema.json", '{"permissions": {}}');
  const out = await loadUserRules(path);
  assertEquals(out, []);
});

Deno.test("config: string entries parse with default action 'ask'", async () => {
  const path = await writeConfig(
    "strings.json",
    JSON.stringify({
      permissions: ["Bash(npm run *)", "Read(/etc/**)"],
    }),
  );
  const out = await loadUserRules(path);
  assertEquals(out.length, 2);
  assertEquals(out[0], { tool: "bash", pattern: "npm run *", action: "ask" });
  assertEquals(out[1], { tool: "read", pattern: "/etc/**", action: "ask" });
});

Deno.test("config: {rule, action} entries honour the declared action", async () => {
  const path = await writeConfig(
    "objects.json",
    JSON.stringify({
      permissions: [
        { rule: "Bash(*)", action: "allow" },
        { rule: "Read(/etc/**)", action: "deny" },
        { rule: "Bash(deploy *)", action: "ask" },
      ],
    }),
  );
  const out = await loadUserRules(path);
  assertEquals(out.length, 3);
  assertEquals(out[0], { tool: "bash", pattern: "*", action: "allow" });
  assertEquals(out[1], { tool: "read", pattern: "/etc/**", action: "deny" });
  assertEquals(out[2], { tool: "bash", pattern: "deploy *", action: "ask" });
});

Deno.test("config: malformed entries are silently dropped, valid ones kept", async () => {
  const path = await writeConfig(
    "mixed.json",
    JSON.stringify({
      permissions: [
        "Bash(*)",
        "not a rule",
        { rule: "Read(/tmp/**)", action: "allow" },
        { rule: "X", action: "allow" }, // parseRule rejects "X" → dropped
        { rule: "Bash(rm *)", action: "bogus" }, // bad action → dropped
        42, // wrong type → dropped
      ],
    }),
  );
  const out = await loadUserRules(path);
  assertEquals(out.length, 2);
  assertEquals(out[0].tool, "bash");
  assertEquals(out[1].tool, "read");
});

Deno.test("config: missing permissions key → []", async () => {
  const path = await writeConfig("empty.json", "{}");
  const out = await loadUserRules(path);
  assertEquals(out, []);
});

Deno.test("config: loadUserRulesEffect wraps the async loader", async () => {
  const path = await writeConfig(
    "eff.json",
    JSON.stringify({ permissions: ["Bash(ls)"] }),
  );
  const out = await Effect.runPromise(loadUserRulesEffect(path));
  const expected: PermissionRule = {
    tool: "bash",
    pattern: "ls",
    action: "ask",
  };
  assertEquals(out.length, 1);
  assert(
    out[0].tool === expected.tool && out[0].pattern === expected.pattern &&
      out[0].action === expected.action,
  );
});

Deno.test("config: negation forms survive the loader", async () => {
  const path = await writeConfig(
    "neg.json",
    JSON.stringify({
      permissions: [
        "!Bash(rm *)",
        { rule: "Read(!/etc/passwd)", action: "allow" },
      ],
    }),
  );
  const out = await loadUserRules(path);
  assertEquals(out.length, 2);
  assertEquals(out[0].pattern, "!rm *");
  assertEquals(out[1].pattern, "!/etc/passwd");
});
