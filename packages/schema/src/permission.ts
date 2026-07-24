import { Schema } from "effect";

// deno-lint-ignore no-slow-types
const RuleAction_ = Schema.Literals(["allow", "deny", "ask"]);
export type RuleAction = Schema.Schema.Type<typeof RuleAction_>;
export const RuleAction: Schema.Codec<RuleAction> = RuleAction_;

// Wildcard rule, e.g. { tool: "bash", pattern: "npm run *", action: "allow" }.
// `tool` is the tool name; `pattern` is matched against the tool's normalization
// string (command line for bash, path for read/write/edit, etc.).
// deno-lint-ignore no-slow-types
const PermissionRule_ = Schema.Struct({
  tool: Schema.String,
  pattern: Schema.String,
  action: RuleAction,
});
export type PermissionRule = Schema.Schema.Type<typeof PermissionRule_>;
export const PermissionRule: Schema.Codec<PermissionRule> = PermissionRule_;

// ---- Policy-chain decision (output of the ordered rule chain) ----

// deno-lint-ignore no-slow-types
const AllowDecision_ = Schema.Struct({
  decision: Schema.Literal("allow"),
});
export type AllowDecision = Schema.Schema.Type<typeof AllowDecision_>;
export const AllowDecision: Schema.Codec<AllowDecision> = AllowDecision_;

// deno-lint-ignore no-slow-types
const DenyDecision_ = Schema.Struct({
  decision: Schema.Literal("deny"),
  reason: Schema.optional(Schema.String),
});
export type DenyDecision = Schema.Schema.Type<typeof DenyDecision_>;
export const DenyDecision: Schema.Codec<DenyDecision> = DenyDecision_;

// deno-lint-ignore no-slow-types
const AskDecision_ = Schema.Struct({
  decision: Schema.Literal("ask"),
});
export type AskDecision = Schema.Schema.Type<typeof AskDecision_>;
export const AskDecision: Schema.Codec<AskDecision> = AskDecision_;

// deno-lint-ignore no-slow-types
const Decision_ = Schema.Union([AllowDecision, DenyDecision, AskDecision]);
export type Decision = Schema.Schema.Type<typeof Decision_>;
export const Decision: Schema.Codec<Decision> = Decision_;

// ---- User-facing approval reply (resolution of an approval.requested) ----

export const ApprovalDecisionType = Schema.Literals([
  "once",
  "always",
  "reject",
]);
export type ApprovalDecisionType = Schema.Schema.Type<
  typeof ApprovalDecisionType
>;
