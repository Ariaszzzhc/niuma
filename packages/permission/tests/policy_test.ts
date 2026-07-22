import type { PermissionRule } from "@niuma/schema";
import { runPolicy, toDecision } from "../src/policy.ts";

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

Deno.test("policy: empty rules + non-readonly tool → Ask (default)", () => {
  const v = runPolicy([], "bash", "ls -la", CWD);
  assertEquals(v.kind, "ask");
});

Deno.test("policy: read-only tool allowed by default", () => {
  for (const tool of ["read", "grep", "glob", "update_plan"]) {
    const v = runPolicy([], tool, "/tmp/x", CWD);
    assertEquals(v.kind, "allow", `${tool} should be auto-allowed`);
  }
});

Deno.test("policy: deny rule wins over allow rule", () => {
  const v = runPolicy(
    [r("bash", "*", "allow"), r("bash", "rm *", "deny")],
    "bash",
    "rm -rf foo",
    CWD,
  );
  assertEquals(v.kind, "deny");
});

Deno.test("policy: deny rule fires even when no allow rule exists", () => {
  const v = runPolicy([r("bash", "rm *", "deny")], "bash", "rm foo", CWD);
  assertEquals(v.kind, "deny");
});

Deno.test("policy: last allow rule wins (LAST match)", () => {
  const v = runPolicy(
    [r("bash", "*", "allow"), r("bash", "*", "ask")],
    "bash",
    "ls",
    CWD,
  );
  assertEquals(v.kind, "ask");
});

Deno.test("policy: deny step beats allow step regardless of order in list", () => {
  const v = runPolicy(
    [
      r("bash", "*", "allow"), // earlier
      r("bash", "rm *", "deny"), // later, but it's a deny rule
    ],
    "bash",
    "rm -rf /",
    CWD,
  );
  assertEquals(v.kind, "deny");
});

Deno.test("policy: sensitive path forces Ask even when allow rule matches", () => {
  if (HOME.length === 0) return;
  const v = runPolicy(
    [r("write", "/**", "allow")],
    "write",
    HOME + "/.ssh/id_rsa",
    CWD,
  );
  assertEquals(v.kind, "ask");
  assertEquals(v.kind === "ask" ? v.reason : "", "sensitive path");
});

Deno.test("policy: .git path forces Ask", () => {
  const v = runPolicy([], "read", "/work/.git/config", CWD);
  assertEquals(v.kind, "ask");
});

Deno.test("policy: ask rule resolves to Ask", () => {
  const v = runPolicy(
    [r("bash", "deploy *", "ask")],
    "bash",
    "deploy prod",
    CWD,
  );
  assertEquals(v.kind, "ask");
});

Deno.test("policy: ask rule is overridden by later allow rule (different action group)", () => {
  const v = runPolicy(
    [
      r("bash", "*", "ask"), // ask step — would fire
      r("bash", "*", "allow"), // allow step — fires before ask step in chain
    ],
    "bash",
    "ls",
    CWD,
  );
  // allow step (step 2) runs BEFORE ask step (step 5), so allow wins.
  assertEquals(v.kind, "allow");
});

Deno.test("policy: tool name matching is case-insensitive", () => {
  const v = runPolicy(
    [r("Bash", "ls", "allow")],
    "bash",
    "ls",
    CWD,
  );
  assertEquals(v.kind, "allow");
});

Deno.test("policy: bash touching ~/.ssh is NOT caught by sensitive guard", () => {
  if (HOME.length === 0) return;
  // The guard applies only to file tools; bash relies on rule DSL.
  const v = runPolicy(
    [],
    "bash",
    `rm ${HOME}/.ssh/id_rsa`,
    CWD,
  );
  assertEquals(v.kind, "ask");
  assertEquals(v.kind === "ask" ? v.reason : "", "default (manual mode)");
});

Deno.test("policy: tool mismatch → no rule matches; read falls through to read-only allowlist", () => {
  // The only rule targets `bash`; tool is `read`, so NO rule matches.
  // With no effective action the chain falls through to the read-only
  // allowlist, which auto-allows `read`. (To force Ask on a read tool,
  // either add a `deny`/`ask` Read(...) rule or touch a sensitive path.)
  const v = runPolicy(
    [r("bash", "*", "allow")],
    "read",
    "/etc/passwd",
    CWD,
  );
  assertEquals(v.kind, "allow");
});

// ---- Explicit coverage of the two contract resolutions ----

Deno.test("policy: cross-action last-match-wins across flattened rulesets", () => {
  // builtin allow < user deny < session ask — all match `ls`. The LAST
  // matching rule wins regardless of action group, so session ask wins.
  // (Under a per-action bucket chain this would return deny; the contract
  // requires pure last-match-wins.)
  const v = runPolicy(
    [
      r("bash", "*", "allow"),
      r("bash", "*", "deny"),
      r("bash", "*", "ask"),
    ],
    "bash",
    "ls",
    CWD,
  );
  assertEquals(v.kind, "ask");
});

Deno.test("policy: later allow overrides earlier deny (session can unblock)", () => {
  // Session-memory is the highest-precedence ruleset; a session allow is
  // the last match and therefore wins over a user-config deny.
  const v = runPolicy(
    [
      r("bash", "rm *", "deny"),
      r("bash", "rm *", "allow"),
    ],
    "bash",
    "rm foo",
    CWD,
  );
  assertEquals(v.kind, "allow");
});

Deno.test("policy: deny still wins when it is the last match", () => {
  const v = runPolicy(
    [
      r("bash", "*", "allow"),
      r("bash", "rm *", "deny"),
    ],
    "bash",
    "rm -rf /",
    CWD,
  );
  assertEquals(v.kind, "deny");
});

Deno.test("policy: sensitive guard fires for read tools touching .git", () => {
  // read is in the read-only allowlist, but the sensitive guard runs first
  // and forces Ask. (Confirms guard ordering: sensitive > read-only.)
  const v = runPolicy([], "read", CWD + "/.git/config", CWD);
  assertEquals(v.kind, "ask");
  assertEquals(v.kind === "ask" ? v.reason : "", "sensitive path");
});

Deno.test("policy: explicit deny on a sensitive path still returns Deny (deny > sensitive)", () => {
  // Deny is stricter than the sensitive Ask, so an effective deny wins.
  const v = runPolicy(
    [r("write", "/**", "deny")],
    "write",
    HOME + "/.ssh/id_rsa",
    CWD,
  );
  assertEquals(v.kind, "deny");
});

Deno.test("policy: sensitive guard does NOT fire for non-file tools (bash)", () => {
  // bash is not in FILE_TOOLS; even a command mentioning id_rsa must rely
  // on the rule DSL, falling through to default Ask.
  const v = runPolicy([], "bash", `cat ${HOME}/.ssh/id_rsa`, CWD);
  assertEquals(v.kind, "ask");
  assertEquals(v.kind === "ask" ? v.reason : "", "default (manual mode)");
});

// ---- Verdict → Decision adapter ----

Deno.test("toDecision: maps Verdict variants to schema Decision one-to-one", () => {
  assertEquals(toDecision(runPolicy([], "bash", "ls", CWD)), { decision: "ask" });
  assertEquals(
    toDecision(runPolicy([r("bash", "rm *", "deny")], "bash", "rm x", CWD)),
    { decision: "deny", reason: "deny rule: bash(rm *)" },
  );
  assertEquals(
    toDecision(runPolicy([], "read", "/tmp/x", CWD)),
    { decision: "allow" },
  );
  // Sensitive-path Ask collapses to the minimal { decision: "ask" } —
  // the richer context (toolName/target/reason) stays on the Verdict.
  assertEquals(
    toDecision(runPolicy([], "read", CWD + "/.git/HEAD", CWD)),
    { decision: "ask" },
  );
});