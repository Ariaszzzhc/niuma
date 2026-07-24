import type { Effect } from "effect";
import type {
  ApprovalDecisionType,
  LiveEvent,
  RecordedEvent,
  ToolResultContent,
} from "@niuma/schema";
import type {
  ProviderAdapter,
  ThinkingConfig,
  ToolDef as ProviderToolDef,
} from "@niuma/provider";

// ---------------------------------------------------------------------------
// Ports. The agent package owns these contracts; @niuma/store and @niuma/tools
// provide concrete adapters, and the server wires them into RunTurnDeps.
// ---------------------------------------------------------------------------

// A recorded event minus the fields the log assigns (seq/ts/sessionId).
// Distributive so each union member keeps its discriminated { type, data }.
type WithoutMeta<T> = T extends unknown ? Omit<T, "seq" | "ts" | "sessionId">
  : never;
export type EventInput = WithoutMeta<RecordedEvent>;

export interface EventLog {
  // Assigns seq/ts/sessionId, appends to the JSONL log, returns the envelope.
  readonly append: (
    sessionId: string,
    input: EventInput,
  ) => Effect.Effect<RecordedEvent>;
  // Full ordered replay of a session's log — the agent's only history source.
  readonly replay: (
    sessionId: string,
  ) => Effect.Effect<ReadonlyArray<RecordedEvent>>;
}

// read-only drops mutating tools (bash/write/edit/apply_patch) for subagents.
export type ToolMode = "full" | "read-only";

export interface ToolCallRequest {
  readonly callId: string;
  readonly name: string;
  readonly input: unknown;
}

export interface ToolRunResult {
  readonly callId: string;
  readonly content: ToolResultContent;
  readonly isError: boolean;
  readonly durationMs: number;
}

export interface ApprovalRequest {
  readonly callId: string;
  readonly name: string;
  readonly input: unknown;
}

export interface ApprovalOutcome {
  readonly decision: ApprovalDecisionType;
  readonly feedback?: string;
}

// Handed to the tool pipeline for a single batch execution. The pipeline runs
// prepare→authorize→schedule→execute; it calls `ask` for any call the policy
// chain leaves unresolved, and `emitProgress` for streaming tool output.
export interface ToolRunContext {
  readonly sessionId: string;
  readonly workspace: string;
  readonly mode: ToolMode;
  readonly signal?: AbortSignal;
  readonly ask: (req: ApprovalRequest) => Effect.Effect<ApprovalOutcome>;
  readonly emitProgress?: (callId: string, message?: string) => void;
}

export interface ToolPipeline {
  // Tool definitions for the model, filtered by mode.
  readonly defs: (mode: ToolMode) => ReadonlyArray<ProviderToolDef>;
  // Authorize + execute a batch, preserving order; never throws — a failed
  // call comes back as a result with isError=true.
  readonly run: (
    batch: ReadonlyArray<ToolCallRequest>,
    ctx: ToolRunContext,
  ) => Effect.Effect<ReadonlyArray<ToolRunResult>>;
}

// The approval gateway bridges the tool pipeline's `ask` to the frontend. The
// agent ships a default (makeApprovalGateway) that records approval.requested,
// parks a resolver in a pending map, and records approval.resolved once the
// server calls resolve(). The server may substitute its own implementation.
export interface ApprovalInfo {
  readonly approvalId: string;
  readonly callId: string;
  readonly name: string;
  readonly input: unknown;
}

export interface ApprovalGateway {
  // Optional `signal` releases a parked approval on session abort so the
  // turn can terminate with turn.aborted instead of hanging on stdin.
  readonly ask: (
    sessionId: string,
    req: ApprovalRequest,
    signal?: AbortSignal,
  ) => Effect.Effect<ApprovalOutcome>;
  readonly resolve: (
    approvalId: string,
    decision: ApprovalDecisionType,
    feedback?: string,
  ) => void;
  readonly pending: ReadonlyMap<string, ApprovalInfo>;
}

export interface RunTurnDeps {
  readonly event_log: EventLog;
  readonly provider: ProviderAdapter;
  readonly tools: ToolPipeline;
  readonly approvals: ApprovalGateway;
  readonly model: string;
  readonly workspace: string;
  readonly mode?: ToolMode;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly temperature?: number;
  // Thinking/reasoning request config; `keep` also gates reasoningContent
  // projection in the context layer (see context.ts projectEvent).
  readonly thinking?: ThinkingConfig;
  readonly signal?: AbortSignal;
  // Live-only sink (SSE). Never persisted; server routes to the frontend.
  readonly emitLive?: (event: LiveEvent) => void;
}
