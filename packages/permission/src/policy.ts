import type { PermissionRule } from "@niuma/schema";
import { lastMatch } from "./matcher.ts";
import { FILE_TOOLS, isSensitivePath } from "./sensitive.ts";

/**
 * Result of evaluating the policy chain. `ask` verdicts carry the
 * information the CLI prompter needs to render the question.
 */
export type Verdict =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason: string }
  | {
    readonly kind: "ask";
    readonly reason: string;
    readonly toolName: string;
    readonly target: string;
    readonly rule?: PermissionRule;
  };

/** Read-only tools that bypass the chain and are always allowed. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "glob",
  "update_plan",
  // `question` is its own user-facing prompt (ctx.ask inside execute);
  // auto-allowing it here avoids a redundant permission prompt before the
  // real one. Kept in sync with @niuma/tools' READ_ONLY_ALLOWED.
  "question",
  // `skill` loads bootstrap-discovered instruction text from an in-memory
  // map — zero IO — so it never warrants a permission prompt.
  "skill",
]);

/**
 * Run the policy chain.
 *
 * Rule resolution: across the flattened ordered rulesets
 * (builtin < user-config < session-memory) the LAST matching rule wins,
 * regardless of its action — so a session rule overrides a user-config
 * rule overrides a builtin rule, even across action groups.
 *
 * Override chain (first that fires wins):
 *   1. effective action `deny`           → Deny
 *   2. sensitive-path guard (file tools) → Ask (forces Ask over an
 *      otherwise-matching `allow`; deny still wins because deny is
 *      stricter than ask)
 *   3. effective action `allow`          → Allow
 *   4. read-only tool allowlist          → Allow
 *   5. effective action `ask`            → Ask
 *   6. default                           → Ask (manual mode: unresolved asks)
 *
 * Note on the contract: the prose says sensitive paths "force Ask"; that
 * can only be true if the guard runs BEFORE the allow step. We therefore
 * order deny → sensitive → allow rather than deny → allow → sensitive.
 */
export function runPolicy(
  rules: ReadonlyArray<PermissionRule>,
  toolName: string,
  target: string,
  cwd: string,
): Verdict {
  const lcTool = toolName.toLowerCase();

  // Last-match-wins rule resolution across the whole flattened ruleset.
  const last = lastMatch(rules, lcTool, target);
  const action = last?.action;

  // 1. deny → Deny (deny is stricter than the sensitive Ask, so it wins)
  if (action === "deny") {
    return {
      kind: "deny",
      reason: `deny rule: ${last!.tool}(${last!.pattern})`,
    };
  }

  // 2. sensitive-path guard → Ask (force Ask over an allow rule)
  if (FILE_TOOLS.has(lcTool) && isSensitivePath(target, cwd)) {
    return {
      kind: "ask",
      reason: "sensitive path",
      toolName,
      target,
    };
  }

  // 3. allow → Allow
  if (action === "allow") {
    return { kind: "allow" };
  }

  // 4. read-only tool allowlist → Allow
  if (READ_ONLY_TOOLS.has(lcTool)) {
    return { kind: "allow" };
  }

  // 5. ask → Ask
  if (action === "ask") {
    return {
      kind: "ask",
      reason: `ask rule: ${last!.tool}(${last!.pattern})`,
      toolName,
      target,
      rule: last,
    };
  }

  // 6. default → Ask (manual mode)
  return {
    kind: "ask",
    reason: "default (manual mode)",
    toolName,
    target,
  };
}
