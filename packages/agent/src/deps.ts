import type { Effect } from "effect";
import type {
  ApprovalDecisionType,
  BillingMode,
  LiveEvent,
  ModelCallActor,
  RecordedEvent,
  ToolResultContent,
  UserMessageEvent,
} from "@niuma/schema";
import type {
  ProviderAdapter,
  ThinkingConfig,
  ToolDef as ProviderToolDef,
} from "@niuma/provider";
import type { SkillInfo } from "./prompt.ts";

// ---------------------------------------------------------------------------
// Ports. The agent package owns these contracts; @niuma/tools provides the
// concrete tool adapter, and the server wires persistence into RunTurnDeps.
// ---------------------------------------------------------------------------

// A recorded event minus the fields the log assigns (seq/ts/sessionId).
// Distributive so each union member keeps its discriminated { type, data }.
type WithoutMeta<T> = T extends unknown ? Omit<T, "seq" | "ts" | "sessionId">
  : never;
export type EventInput = WithoutMeta<RecordedEvent>;

export interface SessionJournal {
  // Assigns seq/ts/sessionId, appends to the Journal, returns the envelope.
  readonly append: (
    sessionId: string,
    input: EventInput,
  ) => Effect.Effect<RecordedEvent>;
  // Full ordered replay of a Journal — the agent's only history source.
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

// The server owns approval lifecycle and persistence. The agent loop only
// needs a port for asking the current frontend decision.
export interface ApprovalGateway {
  readonly ask: (
    sessionId: string,
    req: ApprovalRequest,
    signal?: AbortSignal,
  ) => Effect.Effect<ApprovalOutcome>;
}

export type TurnCloseDecision = "continue" | "close" | "interrupted";

/**
 * Server-owned admission seam for inputs already bound to this Turn.
 *
 * `claim` atomically records pending user messages before returning them, so
 * every returned event is consumed and safe to fold into the Agent's local
 * context mirror. `tryClose` serializes final completion against concurrent
 * steer admission and explicit interrupt.
 */
export interface TurnInput {
  readonly claim: () => Effect.Effect<ReadonlyArray<UserMessageEvent>>;
  readonly tryClose: () => Effect.Effect<TurnCloseDecision>;
}

export interface RunTurnDeps {
  readonly journal: SessionJournal;
  readonly provider: ProviderAdapter;
  readonly tools: ToolPipeline;
  readonly approvals: ApprovalGateway;
  readonly model: string;
  /** Stable provider identity and billing lane recorded with every Model Call. */
  readonly providerId?: string;
  readonly billingMode?: BillingMode;
  readonly actor?: ModelCallActor;
  /** Server-assigned Turn identity; generated locally only for direct tests. */
  readonly turnId?: string;
  readonly workspace: string;
  readonly mode?: ToolMode;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly temperature?: number;
  // Thinking/reasoning request config; `keep` also gates reasoningContent
  // projection in the context layer (see context.ts projectEvent).
  readonly thinking?: ThinkingConfig;
  /** Available agent skills (name+description) for the system-prompt
   * <available_skills> listing; bodies load on demand via the `skill` tool.
   * Server-owned (bootstrap discovery), shared by main and subagent turns. */
  readonly skills?: ReadonlyArray<SkillInfo>;
  readonly signal?: AbortSignal;
  readonly input?: TurnInput;
  // Live-only sink (SSE). Never persisted; server routes to the frontend.
  readonly emitLive?: (event: LiveEvent) => void;
}
