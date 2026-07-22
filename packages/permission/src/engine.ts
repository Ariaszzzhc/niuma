import { Context, Effect, Layer } from "effect";
import type { PermissionRule } from "@niuma/schema";
import { runPolicy, type Verdict } from "./policy.ts";

export interface PermissionEngineShape {
  readonly decide: (
    toolName: string,
    target: string,
  ) => Effect.Effect<Verdict, never, never>;
  readonly registerSessionRule: (
    rule: PermissionRule,
  ) => Effect.Effect<void, never, never>;
  readonly registerUserRule: (
    rule: PermissionRule,
  ) => Effect.Effect<void, never, never>;
  readonly setBuiltinRules: (
    rules: ReadonlyArray<PermissionRule>,
  ) => Effect.Effect<void, never, never>;
  readonly snapshot: () => Effect.Effect<PermissionEngineSnapshot, never, never>;
  readonly allRules: () => Effect.Effect<ReadonlyArray<PermissionRule>, never, never>;
}

export interface PermissionEngineSnapshot {
  readonly builtin: ReadonlyArray<PermissionRule>;
  readonly user: ReadonlyArray<PermissionRule>;
  readonly session: ReadonlyArray<PermissionRule>;
}

export class PermissionEngine extends Context.Service<PermissionEngine, PermissionEngineShape>()(
  "@niuma/permission/PermissionEngine",
) {}

export interface PermissionEngineOptions {
  readonly cwd: string;
  readonly builtinRules?: ReadonlyArray<PermissionRule>;
  readonly userRules?: ReadonlyArray<PermissionRule>;
}

class PermissionEngineImpl implements PermissionEngineShape {
  private builtinRules: PermissionRule[];
  private userRules: PermissionRule[];
  private sessionRules: PermissionRule[];
  private readonly cwd: string;

  constructor(opts: PermissionEngineOptions) {
    this.cwd = opts.cwd;
    this.builtinRules = [...(opts.builtinRules ?? [])];
    this.userRules = [...(opts.userRules ?? [])];
    this.sessionRules = [];
  }

  private flatten(): PermissionRule[] {
    // Sources are concatenated in precedence order: built-in < user < session.
    // The policy chain then applies last-match-wins within each action group,
    // so later sources naturally override earlier ones.
    return [...this.builtinRules, ...this.userRules, ...this.sessionRules];
  }

  decide(toolName: string, target: string): Effect.Effect<Verdict, never, never> {
    return Effect.sync(() => runPolicy(this.flatten(), toolName, target, this.cwd));
  }

  registerSessionRule(rule: PermissionRule): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      this.sessionRules.push(rule);
    });
  }

  registerUserRule(rule: PermissionRule): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      this.userRules.push(rule);
    });
  }

  setBuiltinRules(rules: ReadonlyArray<PermissionRule>): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      this.builtinRules = [...rules];
    });
  }

  snapshot(): Effect.Effect<PermissionEngineSnapshot, never, never> {
    return Effect.sync(() => ({
      builtin: [...this.builtinRules],
      user: [...this.userRules],
      session: [...this.sessionRules],
    }));
  }

  allRules(): Effect.Effect<ReadonlyArray<PermissionRule>, never, never> {
    return Effect.sync(() => this.flatten());
  }
}

/** Build a Layer that wires a fresh PermissionEngine with the given options. */
export function makePermissionEngine(
  opts: PermissionEngineOptions,
): Layer.Layer<PermissionEngine> {
  return Layer.succeed(PermissionEngine, new PermissionEngineImpl(opts));
}