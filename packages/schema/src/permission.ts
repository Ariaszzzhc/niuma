import { Schema } from "effect";

export const RuleAction = Schema.Literals(["allow", "deny", "ask"]);
export type RuleAction = Schema.Schema.Type<typeof RuleAction>;

// Wildcard rule, e.g. { tool: "bash", pattern: "npm run *", action: "allow" }.
// `tool` is the tool name; `pattern` is matched against the tool's normalization
// string (command line for bash, path for read/write/edit, etc.).
export const PermissionRule = Schema.Struct({
  tool: Schema.String,
  pattern: Schema.String,
  action: RuleAction,
});
export type PermissionRule = Schema.Schema.Type<typeof PermissionRule>;

// ---- Policy-chain decision (output of the ordered rule chain) ----

export const AllowDecision = Schema.Struct({
  decision: Schema.Literal("allow"),
});
export type AllowDecision = Schema.Schema.Type<typeof AllowDecision>;

export const DenyDecision = Schema.Struct({
  decision: Schema.Literal("deny"),
  reason: Schema.optional(Schema.String),
});
export type DenyDecision = Schema.Schema.Type<typeof DenyDecision>;

export const AskDecision = Schema.Struct({
  decision: Schema.Literal("ask"),
});
export type AskDecision = Schema.Schema.Type<typeof AskDecision>;

export const Decision = Schema.Union([AllowDecision, DenyDecision, AskDecision]);
export type Decision = Schema.Schema.Type<typeof Decision>;

// ---- User-facing approval reply (resolution of an approval.requested) ----

export const ApprovalDecisionType = Schema.Literals([
  "once",
  "always",
  "reject",
]);
export type ApprovalDecisionType = Schema.Schema.Type<
  typeof ApprovalDecisionType
>;
