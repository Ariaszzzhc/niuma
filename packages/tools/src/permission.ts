import type { PermissionRule } from "@niuma/schema";
import {
  FILE_TOOLS,
  isSensitivePath,
  matchPattern,
  READ_ONLY_TOOLS,
  runPolicy,
  Verdict,
} from "@niuma/permission";
import type { Decision, PermissionEngine, Tool } from "./types.ts";
export type { PermissionEngine };

/**
 * Default in-memory permission engine. Delegates the verdict computation to
 * `@niuma/permission`'s `runPolicy` so the tools package shares one matcher,
 * one glob compiler, and one sensitive-path table with the rest of the
 * codebase. The Promise-based `PermissionEngine` interface stays — it is the
 * seam the plain-Promise pipeline expects.
 *
 * Rule sources mirror @niuma/permission's precedence chain
 * (builtin < user < session, last-match-wins per action group):
 *
 *   1. deny rules            → Deny
 *   2. allow rules           → Allow
 *   3. sensitive-path guard  → Ask (file tools only)
 *   4. read-only allowlist   → Allow
 *   5. ask rules             → Ask
 *   6. default               → Ask (manual mode)
 */
export class MemoryPermissionEngine implements PermissionEngine {
  private readonly builtinRules: PermissionRule[] = [];
  private readonly userRules: PermissionRule[] = [];
  private readonly sessionRules: PermissionRule[] = [];
  private readonly cwd: string;

  constructor(opts: {
    cwd?: string;
    /** Seed built-in rules (e.g. parsed from @niuma/permission/DEFAULT_BUILTINS). */
    builtinRules?: readonly PermissionRule[];
    /** Seed user-scoped rules (e.g. parsed from the config file). */
    userRules?: readonly PermissionRule[];
    /**
     * Legacy knob kept for backwards compatibility with earlier callers and
     * the test suite. The policy chain already forces Ask for every tool that
     * is neither allow-ruled nor read-only, so this no longer changes
     * behaviour — it only documents intent.
     */
    sensitiveTools?: readonly string[];
  } = {}) {
    this.cwd = opts.cwd ?? Deno.cwd();
    if (opts.builtinRules) this.builtinRules.push(...opts.builtinRules);
    if (opts.userRules) this.userRules.push(...opts.userRules);
    // opts.sensitiveTools accepted for backwards compat; the policy chain
    // already routes unresolved calls through Ask.
  }

  /** Tag additional rules as built-in (lowest precedence). */
  setBuiltinRules(rules: readonly PermissionRule[]): void {
    this.builtinRules.length = 0;
    this.builtinRules.push(...rules);
  }

  /** Append a user-scoped rule (overrides built-ins, under session rules). */
  addUserRule(rule: PermissionRule): void {
    this.userRules.push(rule);
  }

  /** Direct port of @niuma/permission's runPolicy for callers that want a Verdict. */
  policyFor(req: {
    name: string;
    pattern: string;
  }): Verdict {
    return runPolicy(this.allRules(), req.name, req.pattern, this.cwd);
  }

  /** All rules concatenated in precedence order. */
  allRules(): readonly PermissionRule[] {
    return [
      ...this.builtinRules,
      ...this.userRules,
      ...this.sessionRules,
    ];
  }

  async evaluate(req: {
    callId: string;
    sessionId: string;
    name: string;
    pattern: string;
  }): Promise<Decision> {
    const verdict = runPolicy(
      this.allRules(),
      req.name,
      req.pattern,
      this.cwd,
    );
    if (verdict.kind === "allow") return { decision: "allow" };
    if (verdict.kind === "deny") {
      return { decision: "deny", reason: verdict.reason };
    }
    return { decision: "ask" };
  }

  /**
   * Persist a session-scoped rule (typically from an `always` approval reply).
   * The rule applies to subsequent `evaluate` calls in every session — the
   * session id is carried in the request payload for tracing, not for
   * isolation. This matches @niuma/permission's chain model where session
   * rules are simply the highest-precedence layer.
   */
  async remember(rule: PermissionRule): Promise<void> {
    this.sessionRules.push(rule);
  }

  patternFor(name: string, input: unknown): string {
    if (input == null) return "";
    if (typeof input === "string") return input;
    if (typeof input !== "object") return String(input);
    const obj = input as Record<string, unknown>;
    for (const key of ["command", "pattern", "path", "patch", "question"]) {
      const v = obj[key];
      if (typeof v === "string") return v;
    }
    return JSON.stringify(input);
  }
}

/**
 * Glob → anchored RegExp via @niuma/permission. Kept as a named export for
 * direct callers (the test suite uses it). Supports `*` (any chars including
 * `/`), `?` (any single char except `/`), and a leading `!` for negation.
 */
export function matchWildcard(pattern: string, value: string): boolean {
  return matchPattern(pattern, value);
}

/** Re-exports so the tools package has one obvious import surface. */
export {
  FILE_TOOLS,
  isSensitivePath,
  READ_ONLY_TOOLS,
  runPolicy,
};
export type { Verdict };

/**
 * Convenience factory: wire a `PermissionEngine` to a registry of tools so
 * `patternFor` honours each tool's `normalize`.
 */
export function makeEngine(
  tools: ReadonlyMap<string, Tool>,
  opts?: {
    cwd?: string;
    builtinRules?: readonly PermissionRule[];
    userRules?: readonly PermissionRule[];
    sensitiveTools?: readonly string[];
  },
): PermissionEngine {
  const engine = new MemoryPermissionEngine(opts);
  return {
    evaluate: (req) => engine.evaluate(req),
    remember: (rule) => engine.remember(rule),
    patternFor(name, input) {
      const tool = tools.get(name);
      if (!tool) return engine.patternFor(name, input);
      const raw = tool.normalize ? safeParse(tool, input) : input;
      return tool.normalize ? tool.normalize(raw as never) : engine.patternFor(name, raw);
    },
  };
}

function safeParse<I>(tool: Tool<I>, input: unknown): I {
  const parsed = tool.inputSchema.safeParse(input);
  return parsed.success ? parsed.data : (input as I);
}
