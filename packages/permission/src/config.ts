import { Effect, Schema } from "effect";
import { join } from "@std/path";
import type { PermissionRule } from "@niuma/schema";
import { parseRule, parseRuleWithAction } from "./parser.ts";

const ConfigFileSchema = Schema.Struct({
  // We only pin the top-level shape here. Entries are validated one-by-one
  // by `coerceRule` so that a single malformed entry is silently dropped
  // instead of poisoning the whole file (the documented behaviour).
  permissions: Schema.optional(Schema.Array(Schema.Unknown)),
});

/** Built-in defaults. Conservative: nothing is implicitly allowed. */
export const DEFAULT_BUILTINS: ReadonlyArray<PermissionRule> = [];

/** Default path to the user config file. */
export function defaultConfigPath(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "~";
  return join(home, ".niuma", "config.json");
}

function coerceRule(input: unknown): PermissionRule | null {
  if (typeof input === "string") {
    try {
      return parseRuleWithAction(input, "ask");
    } catch {
      return null;
    }
  }
  if (
    input && typeof input === "object" && "rule" in input && "action" in input
  ) {
    const rule = (input as { rule: unknown }).rule;
    const action = (input as { action: unknown }).action;
    if (typeof rule !== "string") return null;
    if (action !== "allow" && action !== "deny" && action !== "ask") return null;
    try {
      const parsed = parseRule(rule);
      return { tool: parsed.tool, pattern: parsed.pattern, action };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Load user rules from `path`. Malformed entries are silently dropped —
 * a missing or unreadable file yields no rules rather than an error, so
 * the engine can fall through to its built-in defaults.
 */
export async function loadUserRules(
  path: string,
): Promise<ReadonlyArray<PermissionRule>> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  let decoded: { permissions?: ReadonlyArray<unknown> };
  try {
    decoded = Schema.decodeUnknownSync(ConfigFileSchema)(parsed);
  } catch {
    return [];
  }
  const list = decoded.permissions ?? [];
  const out: PermissionRule[] = [];
  for (const entry of list) {
    const r = coerceRule(entry);
    if (r) out.push(r);
  }
  return out;
}

export function loadUserRulesEffect(
  path: string,
): Effect.Effect<ReadonlyArray<PermissionRule>, never, never> {
  return Effect.promise(() => loadUserRules(path));
}