import { Effect } from "effect";
import {
  makePermissionEngine,
  PermissionEngine,
  type PermissionEngineOptions,
  type PermissionEngineShape,
} from "../src/engine.ts";
import type { PermissionRule } from "@niuma/schema";

function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(msg ?? `assertEquals: ${a} !== ${b}`);
}

const CWD = "/work";
const HOME = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";

function r(
  tool: string,
  pattern: string,
  action: PermissionRule["action"],
): PermissionRule {
  return { tool, pattern, action };
}

/** Run a program with a fresh PermissionEngine layered in. */
async function runWithEngine<T>(
  opts: PermissionEngineOptions,
  program: (svc: PermissionEngineShape) => Effect.Effect<T, never, never>,
): Promise<T> {
  const layer = makePermissionEngine(opts);
  const built = Effect.provide(
    Effect.gen(function* () {
      const svc = yield* PermissionEngine;
      return yield* program(svc);
    }),
    layer,
  );
  return await Effect.runPromise(built);
}

Deno.test("engine: built-in < user < session precedence (last match wins)", async () => {
  const verdict = await runWithEngine(
    {
      cwd: CWD,
      builtinRules: [r("bash", "*", "allow")],
      userRules: [r("bash", "*", "deny")],
    },
    (svc) =>
      Effect.gen(function* () {
        yield* svc.registerSessionRule(r("bash", "*", "ask"));
        return yield* svc.decide("bash", "ls");
      }),
  );
  // session "ask" is last → Ask wins.
  assertEquals(verdict.kind, "ask");
});

Deno.test("engine: empty session → user deny beats builtin allow", async () => {
  const verdict = await runWithEngine(
    {
      cwd: CWD,
      builtinRules: [r("bash", "*", "allow")],
      userRules: [r("bash", "*", "deny")],
    },
    (svc) => svc.decide("bash", "ls"),
  );
  assertEquals(verdict.kind, "deny");
});

Deno.test("engine: registerSessionRule appends and is consulted", async () => {
  const verdict = await runWithEngine(
    { cwd: CWD },
    (svc) =>
      Effect.gen(function* () {
        yield* svc.registerSessionRule(r("bash", "echo *", "allow"));
        return yield* svc.decide("bash", "echo hello");
      }),
  );
  assertEquals(verdict.kind, "allow");
});

Deno.test("engine: setBuiltinRules replaces builtins", async () => {
  const verdict = await runWithEngine(
    {
      cwd: CWD,
      builtinRules: [r("bash", "*", "deny")],
    },
    (svc) =>
      Effect.gen(function* () {
        yield* svc.setBuiltinRules([]);
        return yield* svc.decide("bash", "ls");
      }),
  );
  // no rules → default ask
  assertEquals(verdict.kind, "ask");
});

Deno.test("engine: snapshot exposes all three buckets", async () => {
  const snap = await runWithEngine(
    {
      cwd: CWD,
      builtinRules: [r("bash", "*", "allow")],
      userRules: [r("read", "/tmp/**", "deny")],
    },
    (svc) =>
      Effect.gen(function* () {
        yield* svc.registerSessionRule(r("write", "/tmp/**", "ask"));
        return yield* svc.snapshot();
      }),
  );
  assertEquals(snap.builtin.length, 1);
  assertEquals(snap.user.length, 1);
  assertEquals(snap.session.length, 1);
  assertEquals(snap.builtin[0].action, "allow");
  assertEquals(snap.user[0].tool, "read");
  assertEquals(snap.session[0].action, "ask");
});

Deno.test("engine: Context.Service tag is wired through a Layer", async () => {
  const layer = makePermissionEngine({
    cwd: CWD,
    builtinRules: [r("read", "/**", "allow")],
  });
  const program = Effect.gen(function* () {
    const svc = yield* PermissionEngine;
    return yield* svc.decide("read", "/foo/bar");
  });
  const verdict = await Effect.runPromise(Effect.provide(program, layer));
  assertEquals(verdict.kind, "allow");
});

Deno.test("engine: allRules concatenates sources in precedence order", async () => {
  const all = await runWithEngine(
    {
      cwd: CWD,
      builtinRules: [r("bash", "*", "allow")],
      userRules: [r("read", "*", "allow")],
    },
    (svc) =>
      Effect.gen(function* () {
        yield* svc.registerSessionRule(r("write", "*", "allow"));
        return yield* svc.allRules();
      }),
  );
  assertEquals(all.length, 3);
  assertEquals(all[0].tool, "bash");
  assertEquals(all[1].tool, "read");
  assertEquals(all[2].tool, "write");
});

Deno.test("engine: HOME sensitive path forces Ask even with allow rule", async () => {
  if (HOME.length === 0) return;
  const verdict = await runWithEngine(
    {
      cwd: CWD,
      builtinRules: [r("write", "/**", "allow")],
    },
    (svc) => svc.decide("write", HOME + "/.ssh/id_rsa"),
  );
  assertEquals(verdict.kind, "ask");
});