// ===========================================================================
// @niuma/tui — built-in slash command registry + parsing tests (pure)
// ---------------------------------------------------------------------------
// Covers the pure half of the built-in command dispatch: the `/name args`
// parser (alias resolution, built-in-vs-custom fallthrough), the /resume id
// resolver (exact / unique-prefix / ambiguous / not-found), and the /help +
// session-list text builders. No terminal, no native lib, no client.
// ===========================================================================

import { assertEquals } from "@std/assert";
import type { SessionInfo } from "@niuma/schema";
import {
  BUILTIN_COMMANDS,
  formatSessionList,
  helpLines,
  parseBuiltinCommand,
  resolveSessionId,
  slashCommandCandidates,
} from "../src/commands.ts";

Deno.test("registry covers the nine built-ins", () => {
  assertEquals(
    BUILTIN_COMMANDS.map((c) => c.name),
    [
      "help",
      "exit",
      "model",
      "effort",
      "delivery",
      "compact",
      "clear",
      "resume",
      "mcp",
    ],
  );
});

Deno.test("parseBuiltinCommand parses name and argument text", () => {
  assertEquals(parseBuiltinCommand("/model openai/gpt-5"), {
    name: "model",
    args: "openai/gpt-5",
  });
  assertEquals(parseBuiltinCommand("/compact"), { name: "compact", args: "" });
  // multi-word arguments are kept (trimmed)
  assertEquals(parseBuiltinCommand("/resume  abc  "), {
    name: "resume",
    args: "abc",
  });
});

Deno.test("parseBuiltinCommand resolves the /quit alias to exit", () => {
  assertEquals(parseBuiltinCommand("/quit"), { name: "exit", args: "" });
  assertEquals(parseBuiltinCommand("/exit"), { name: "exit", args: "" });
});

Deno.test("parseBuiltinCommand returns null for non-builtins and plain text", () => {
  assertEquals(parseBuiltinCommand("/review file.ts"), null); // custom
  assertEquals(parseBuiltinCommand("/whatever"), null);
  assertEquals(parseBuiltinCommand("hello world"), null);
  assertEquals(parseBuiltinCommand(""), null);
});

Deno.test("resolveSessionId: exact wins, unique prefix resolves, ties are ambiguous", () => {
  const ids = ["abc123", "abd999", "zzz"];
  assertEquals(resolveSessionId(ids, "abc123"), {
    type: "ok",
    sessionId: "abc123",
  });
  assertEquals(resolveSessionId(ids, "abc"), {
    type: "ok",
    sessionId: "abc123",
  });
  assertEquals(resolveSessionId(ids, "ab"), {
    type: "ambiguous",
    matches: ["abc123", "abd999"],
  });
  assertEquals(resolveSessionId(ids, "nope"), { type: "not-found" });
});

Deno.test("helpLines lists keys, built-ins, and custom commands", () => {
  const lines = helpLines([{ name: "review" }]);
  assertEquals(lines.length, 3);
  assertEquals(lines[0].includes("ctrl+p palette"), true);
  assertEquals(lines[1].includes("/compact"), true);
  assertEquals(lines[2], "custom commands: /review");
  // no custom section when there are none
  assertEquals(helpLines([]).length, 2);
});

Deno.test("formatSessionList renders id/status/model/title rows", () => {
  const row: SessionInfo = {
    sessionId: "s1",
    workspace: "/w",
    model: "m1",
    createdAt: 1,
    updatedAt: 2,
    status: "idle",
    title: "hello",
  };
  assertEquals(formatSessionList([row]), ["s1  [idle]  m1  hello"]);
  assertEquals(formatSessionList([]), ["no sessions found"]);
});

Deno.test("slashCommandCandidates: prefix filter, sorted, with descriptions", () => {
  const all = slashCommandCandidates("", []);
  // 9 built-ins + the /quit alias
  assertEquals(all.length, 10);
  assertEquals(all[0].name, "clear");
  assertEquals(
    all.every((c) => c.description !== undefined && c.builtin),
    true,
  );

  const c = slashCommandCandidates("c", []);
  assertEquals(c.map((x) => x.name), ["clear", "compact"]);

  assertEquals(slashCommandCandidates("xyz", []), []);
});

Deno.test("slashCommandCandidates: alias row is annotated and resolves in its own spelling", () => {
  const q = slashCommandCandidates("qui", []);
  assertEquals(q.length, 1);
  assertEquals(q[0].name, "quit");
  assertEquals(q[0].builtin, true);
  assertEquals(q[0].description?.includes("alias for /exit"), true);
});

Deno.test("slashCommandCandidates: matching is case-insensitive", () => {
  assertEquals(slashCommandCandidates("HEL", []).map((c) => c.name), ["help"]);
});

Deno.test("slashCommandCandidates: custom commands join in, deduped against built-ins", () => {
  const custom = [
    { name: "review", description: "Review code" },
    { name: "help", description: "shadow attempt" },
  ];
  const rev = slashCommandCandidates("rev", custom);
  assertEquals(rev.length, 1);
  assertEquals(rev[0], {
    name: "review",
    description: "Review code",
    builtin: false,
  });
  // the shadowing custom "help" does not produce a second row
  const help = slashCommandCandidates("hel", custom);
  assertEquals(help.length, 1);
  assertEquals(help[0].builtin, true);
  // ...and the full candidate list still counts help once
  const all = slashCommandCandidates("", custom);
  assertEquals(all.filter((c) => c.name === "help").length, 1);
});
