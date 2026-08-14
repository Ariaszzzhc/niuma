import type { z } from "zod";
import type {
  ApprovalDecisionType,
  Decision,
  PermissionRule,
} from "@niuma/schema";

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
  // `skill` is a pure lookup over the bootstrap-time skills map (zero IO).
  "skill",
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

/** The three reply options surfaced when the policy chain asks. */
export type ApprovalDecisionLiteral = ApprovalDecisionType;

export interface ApprovalDecision {
  decision: ApprovalDecisionLiteral;
  /** Echoed back as an `isError` result when `decision === "reject"`. */
  feedback?: string;
}

export interface SubagentResult {
  sessionId: string;
  /** Final text for the parent model. On failure the server spawner
   * composes the reason + execution trace into this text. */
  text: string;
  /** False when the child refused to start or terminated abnormally. */
  ok: boolean;
}

export interface ToolCtx {
  /**
   * The provider-issued tool call id for the call currently executing.
   *
   * This is the correlation key used by tool.progress, approval.requested,
   * tool.result, and the TUI. Tools must not invent a second id for those
   * channels. Spill files may still prefix this with the session id.
   */
  callId: string;
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
    /** Short display name invented by the parent model; recorded on
     * subagent.spawned and shown in the TUI agent strip. */
    name: string;
    mode?: "default" | "read-only";
    parentSessionId: string;
    callId: string;
  }): Promise<SubagentResult>;
}

/**
 * Context shared while preparing/authorising a batch. `runPipeline` adds the
 * concrete provider call id immediately before invoking each tool.
 */
export type ToolBatchCtx = Omit<ToolCtx, "callId">;

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
// The pipeline depends on this narrow port so tests and runtime policy stores
// can vary without changing tool execution.

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
  /** Persist an allow/deny rule for exactly one session. */
  remember(sessionId: string, rule: PermissionRule): Promise<void>;
}

// ---- Schema helpers (re-exported for the registry) ----
export type {
  Decision,
  PermissionRule,
  ToolResultContent,
} from "@niuma/schema";
