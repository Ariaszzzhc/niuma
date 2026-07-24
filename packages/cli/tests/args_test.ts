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
import { parseCliArgs } from "../src/args.ts";

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
