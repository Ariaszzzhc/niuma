import type { z } from "zod";
import type { PermissionRule, ToolResultContent } from "@niuma/schema";

// ---- Resource footprint declared by a tool ----

export interface FileAccess {
  read?: readonly string[];
  write?: readonly string[];
}

export interface Accesses {
  files?: FileAccess;
  network?: boolean;
  process?: boolean;
  /** Approximate cost in tokens — the agent loop uses this to budget pre-sampling. */
  costHint?: "small" | "medium" | "large";
}

/**
 * Tool-exposure mode. The agent uses this to keep subagents from mutating
 * the workspace: `read-only` drops bash/write/edit/apply_patch/spawn_subagent
 * from the registry's defs and short-circuits any mutating call that slips
 * past.
 */
export type ToolMode = "full" | "read-only";

/** Tools that may run in `read-only` mode. */
export const READ_ONLY_ALLOWED: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "glob",
  "update_plan",
  "question",
]);

// ---- Tool execution context ----

export interface ApprovalInfo {
  callId: string;
  name: string;
  /** Human-readable summary of what's being attempted. */
  summary: string;
  /** Normalized form fed to the policy chain (command line, path, ...). */
  pattern: string;
  /** Whether the tool believes this is sensitive (e.g. escapes workspace). */
  sensitive: boolean;
  /** Tool-specific detail shown in the prompt (path, command preview, ...). */
  detail?: string;
}

/**
 * The three reply options surfaced to the user when the policy chain asks.
 * We re-declare the literal union locally because `@niuma/schema` may still
 * be mid-migration to Effect v4's `Schema.Literal(value, ...values)` shape.
 */
export type ApprovalDecisionLiteral = "once" | "always" | "reject";

export interface ApprovalDecision {
  decision: ApprovalDecisionLiteral;
  /** Echoed back as an `isError` result when `decision === "reject"`. */
  feedback?: string;
}

export interface SubagentResult {
  sessionId: string;
  /** Final assistant text from the child run. */
  text: string;
}

export interface ToolCtx {
  cwd: string;
  sessionId: string;
  signal: AbortSignal;
  /** Route an Ask decision through to the user. */
  ask(info: ApprovalInfo): Promise<ApprovalDecision>;
  /** Optional progress reporter (wired by the agent package). */
  emitProgress?(callId: string, message: string): void;
  /** Optional subagent spawner (wired by the agent package). */
  spawnSubagent?(req: {
    prompt: string;
    mode?: "default" | "read-only";
    parentSessionId: string;
  }): Promise<SubagentResult>;
}

// ---- Tool definition + output ----

/** A tool-agnostic JSON-Schema-shaped object (matches ToolDef.parameters). */
export type JsonSchemaObject = Record<string, unknown>;

export interface ToolOutput {
  /** Plain text or an array of `{type:"text", text}` blocks. */
  content: string;
  isError?: boolean;
  /**
   * When truncation kicked in, the full output was spilled to
   * ~/.niuma/output/<callId>.log and this points at it.
   */
  spillPath?: string;
  /** Echoed by the pipeline so consumers (agent adapter) don't lose track. */
  callId?: string;
  /** Per-call wall-clock duration in milliseconds, filled by the pipeline. */
  durationMs?: number;
}

export interface ToolDefLike {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
}

export interface Tool<I = unknown> {
  /** Public definition surfaced to the LLM. */
  readonly def: ToolDefLike;
  /** Resource footprint for the scheduler. */
  readonly accesses: Accesses;
  /** Stable identity for log lines; defaults to `def.name`. */
  readonly name: string;
  /** zod schema for the input — produces a normalised object before execute. */
  readonly inputSchema: z.ZodType<I>;
  /** Normalise raw LLM input → the field the policy chain matches on. */
  normalize?(input: I): string;
  /**
   * Compute the concrete filesystem paths this call will touch, given the
   * parsed input. Paths may be relative (resolved against `cwd` by the
   * pipeline) or absolute. The pipeline merges these into
   * `PreparedCall.accesses` so the scheduler can serialise conflicting
   * reads/writes and the authoriser can apply the sensitive-path guard.
   */
  paths?(input: I): { read?: readonly string[]; write?: readonly string[] };
  execute(input: I, ctx: ToolCtx): Promise<ToolOutput>;
}

// ---- Pipeline input/output ----

/**
 * Local mirror of the schema package's `Decision` type. We redeclare it
 * because `@niuma/schema` may not have fully migrated to Effect v4's
 * `Schema.Union([...])` shape yet; the runtime values interop fine.
 */
export type Decision =
  | { decision: "allow" }
  | { decision: "deny"; reason?: string }
  | { decision: "ask" };

export interface PreparedCall<I = unknown> {
  callId: string;
  name: string;
  input: I;
  /** Normalised form, already settled by `prepare`. */
  pattern: string;
  /** Computed resource footprint (after path normalisation). */
  accesses: Accesses;
  /**
   * Set by `prepare` when any resolved path escapes the workspace root.
   * `authorize` uses this to force an Ask regardless of the engine verdict.
   */
  escapesWorkspace?: boolean;
}

export interface AuthorizeOutcome {
  decision: Decision;
  /** For ask → the user-facing summary. */
  approval?: ApprovalInfo;
}

export interface ToolCallRecord {
  callId: string;
  name: string;
  input: unknown;
}

// ---- Permission engine contract ----
//
// The tools package consumes a `PermissionEngine`. Concrete implementations
// live in @niuma/permission; this is the seam the pipeline depends on so the
// engine can be swapped (CLI vs TUI vs tests) without touching tool code.

export interface PermissionEngine {
  /**
   * Evaluate a single tool call. May return Ask — in which case the pipeline
   * will route through `ToolCtx.ask` and either continue, deny, or persist
   * an "always" rule via `remember`.
   */
  evaluate(req: {
    callId: string;
    sessionId: string;
    name: string;
    pattern: string;
  }): Promise<Decision>;
  /** Persist a session-scoped allow/deny rule (from an `always` reply). */
  remember(rule: PermissionRule): Promise<void>;
  /** Return the tool's normalisation string for a given input (uses Tool.normalize). */
  patternFor(name: string, input: unknown): string;
}

// ---- Schema helpers (re-exported for the registry) ----
export type { PermissionRule, ToolResultContent } from "@niuma/schema";