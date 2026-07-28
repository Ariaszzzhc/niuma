// ===========================================================================
// @niuma/cli — argument parsing tests
// ---------------------------------------------------------------------------
// Covers the pipe-protection guard for the explicit `niuma tui` form: a
// non-TTY stdin (e.g. `echo hi | niuma tui`) must refuse with help + exit 2
// (mirroring bare `niuma`) instead of failing deep inside the terminal layer.
//
// `deno test` runs with a non-TTY stdin, so these assertions execute under the
// harness; in an interactive terminal they no-op (we cannot force a non-TTY
// stdin in-process, so the guard keeps the test deterministic either way).
// ===========================================================================

import { assertEquals } from "@std/assert";
import { resolve } from "@std/path";
import { parseCliArgs } from "../src/args.ts";

Deno.test("args: one-shot permission bypass is explicit and defaults off", () => {
  const normal = parseCliArgs(["-p", "task"]);
  if (!normal.ok || normal.args.subcommand !== "oneshot") {
    throw new Error("expected one-shot args");
  }
  assertEquals(normal.args.bypassPermissions, false);

  const bypass = parseCliArgs([
    "-p",
    "task",
    "--dangerously-bypass-permissions",
  ]);
  if (!bypass.ok || bypass.args.subcommand !== "oneshot") {
    throw new Error("expected one-shot args");
  }
  assertEquals(bypass.args.bypassPermissions, true);
});

Deno.test("args: one-shot carries explicit workspace, model, and resume", () => {
  const parsed = parseCliArgs([
    "-p",
    "continue",
    "--workspace",
    ".",
    "--model",
    "openai/gpt-5",
    "--resume",
    "session-1",
  ]);
  if (!parsed.ok || parsed.args.subcommand !== "oneshot") {
    throw new Error("expected one-shot args");
  }
  assertEquals(parsed.args.model, "openai/gpt-5");
  assertEquals(parsed.args.resume, "session-1");
  assertEquals(parsed.args.workspace.startsWith("/"), true);
});

Deno.test("args: serve binds one explicit workspace", () => {
  const parsed = parseCliArgs([
    "serve",
    "--workspace",
    ".",
    "--port",
    "4100",
  ]);
  if (!parsed.ok || parsed.args.subcommand !== "serve") {
    throw new Error("expected serve args");
  }
  assertEquals(parsed.args.workspace.startsWith("/"), true);
  assertEquals(parsed.args.port, 4100);
});

Deno.test("args: explicit workspace wins, otherwise NIUMA_WORKSPACE is the default", () => {
  const previous = Deno.env.get("NIUMA_WORKSPACE");
  try {
    Deno.env.set("NIUMA_WORKSPACE", resolve("env-workspace"));
    const inherited = parseCliArgs(["-p", "task"]);
    if (!inherited.ok || inherited.args.subcommand !== "oneshot") {
      throw new Error("expected one-shot args");
    }
    assertEquals(inherited.args.workspace, resolve("env-workspace"));

    const explicit = parseCliArgs([
      "-p",
      "task",
      "--workspace",
      "explicit-workspace",
    ]);
    if (!explicit.ok || explicit.args.subcommand !== "oneshot") {
      throw new Error("expected one-shot args");
    }
    assertEquals(explicit.args.workspace, resolve("explicit-workspace"));
  } finally {
    if (previous === undefined) Deno.env.delete("NIUMA_WORKSPACE");
    else Deno.env.set("NIUMA_WORKSPACE", previous);
  }
});

Deno.test("args: `niuma tui` refuses a non-TTY stdin with help + exit 2", () => {
  if (Deno.stdin.isTerminal()) return; // no-op in an interactive terminal
  const r = parseCliArgs(["tui"]);
  assertEquals(r.ok, false);
  assertEquals((r as { exitCode: number }).exitCode, 2);
});

Deno.test("args: `niuma tui --help` still prints help on a non-TTY stdin", () => {
  // --help is resolved before the non-TTY guard, so it must exit 0 (help
  // printed) regardless of stdin.
  if (Deno.stdin.isTerminal()) return;
  const r = parseCliArgs(["tui", "--help"]);
  assertEquals(r.ok, false);
  assertEquals((r as { exitCode: number }).exitCode, 0);
});

Deno.test("args: `niuma tui` with a TTY launches interactive (structural)", () => {
  // Only meaningful in an interactive terminal; confirms the happy path still
  // returns an interactive args object (not a refusal) when stdin IS a TTY.
  if (!Deno.stdin.isTerminal()) return;
  const r = parseCliArgs(["tui"]);
  assertEquals(r.ok, true);
  assertEquals(
    (r as { args: { subcommand: string } }).args.subcommand,
    "interactive",
  );
});

// ===========================================================================
// `niuma auth` subcommand parsing
// ---------------------------------------------------------------------------
// These cover the pure parser only (no OAuth/network), so they run under the
// deno-test harness regardless of the oauth lane landing. runAuth behaviour is
// exercised separately.
// ===========================================================================

type AuthParsed = {
  subcommand: "auth";
  action: "login" | "logout" | "status";
  providerId?: string;
  deviceCode: boolean;
};

const asAuth = (r: ReturnType<typeof parseCliArgs>): AuthParsed => {
  if (!r.ok) throw new Error("expected ok parse");
  return r.args as AuthParsed;
};

Deno.test("args: `niuma auth login` leaves the provider unset (picker), no device-code", () => {
  const a = asAuth(parseCliArgs(["auth", "login"]));
  assertEquals(a.subcommand, "auth");
  assertEquals(a.action, "login");
  // Undefined = runLogin shows the first-level provider picker (kimi /
  // openai / anthropic / custom); logout/status fall back to "openai".
  assertEquals(a.providerId, undefined);
  assertEquals(a.deviceCode, false);
});

Deno.test("args: `niuma auth login openai --device-code` parses the flag + provider", () => {
  const a = asAuth(parseCliArgs(["auth", "login", "openai", "--device-code"]));
  assertEquals(a.action, "login");
  assertEquals(a.providerId, "openai");
  assertEquals(a.deviceCode, true);
});

Deno.test("args: `niuma auth logout deepseek` carries an explicit provider", () => {
  const a = asAuth(parseCliArgs(["auth", "logout", "deepseek"]));
  assertEquals(a.action, "logout");
  assertEquals(a.providerId, "deepseek");
});

Deno.test("args: `niuma auth list` is accepted as an alias for `status`", () => {
  const a = asAuth(parseCliArgs(["auth", "list"]));
  assertEquals(a.action, "status");
});

Deno.test("args: `niuma auth status` leaves the provider unset (falls back to openai at run time)", () => {
  const a = asAuth(parseCliArgs(["auth", "status"]));
  assertEquals(a.action, "status");
  assertEquals(a.providerId, undefined);
});

Deno.test("args: `niuma auth bogus` is an unknown action -> exit 1", () => {
  const r = parseCliArgs(["auth", "bogus"]);
  assertEquals(r.ok, false);
  assertEquals((r as { exitCode: number }).exitCode, 1);
});

Deno.test("args: `niuma auth` with no action prints help -> exit 0", () => {
  const r = parseCliArgs(["auth"]);
  assertEquals(r.ok, false);
  assertEquals((r as { exitCode: number }).exitCode, 0);
});
