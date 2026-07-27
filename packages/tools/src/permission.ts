import type { PermissionRule } from "@niuma/schema";
import { runPolicy } from "@niuma/permission";
import type { Decision, PermissionEngine } from "./types.ts";
export type { PermissionEngine };

/**
 * Default in-memory permission engine. Delegates the verdict computation to
 * `@niuma/permission`'s `runPolicy` so the tools package shares one matcher,
 * one glob compiler, and one sensitive-path table with the rest of the
 * codebase. The Promise-based `PermissionEngine` interface stays — it is the
 * seam the plain-Promise pipeline expects.
 *
 * The only mutable policy state is the set of rules remembered for each
 * session after an `always` approval. Static matching and precedence live in
 * `@niuma/permission`; tool-specific normalisation happens once in the
 * pipeline before this engine is called.
 */
export class MemoryPermissionEngine implements PermissionEngine {
  private readonly sessionRules = new Map<string, PermissionRule[]>();
  private readonly cwd: string;

  constructor(opts: { cwd?: string } = {}) {
    this.cwd = opts.cwd ?? Deno.cwd();
  }

  evaluate(req: {
    callId: string;
    sessionId: string;
    name: string;
    pattern: string;
  }): Promise<Decision> {
    const verdict = runPolicy(
      this.sessionRules.get(req.sessionId) ?? [],
      req.name,
      req.pattern,
      this.cwd,
    );
    if (verdict.kind === "allow") return Promise.resolve({ decision: "allow" });
    if (verdict.kind === "deny") {
      return Promise.resolve({ decision: "deny", reason: verdict.reason });
    }
    return Promise.resolve({ decision: "ask" });
  }

  /** Persist a rule for one session (typically from an `always` reply). */
  remember(sessionId: string, rule: PermissionRule): Promise<void> {
    const rules = this.sessionRules.get(sessionId);
    if (rules) rules.push(rule);
    else this.sessionRules.set(sessionId, [rule]);
    return Promise.resolve();
  }
}
