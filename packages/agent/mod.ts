export const AGENT_VERSION = "0.0.0";

export { runTurn } from "./src/loop.ts";
export type { TurnResult } from "./src/loop.ts";

export {
  AgentSession,
  SessionManager,
} from "./src/session.ts";
export type { AgentInfra, SessionOptions } from "./src/session.ts";

export { makeApprovalGateway } from "./src/approval.ts";

export { buildSystemPrompt } from "./src/prompt.ts";
export {
  estimateRequestTokens,
  estimateTokens,
  eventsToMessages,
  projectEvent,
  resultContentToString,
} from "./src/context.ts";
export {
  buildSummary,
  compactMessages,
  isSummaryMessage,
  SUMMARIZATION_PROMPT,
  SUMMARY_PREFIX,
  summarizeHistory,
} from "./src/compaction.ts";
export type { SummarizeDeps } from "./src/compaction.ts";
export { makeToolPipeline } from "./src/tool_pipeline.ts";
export type { MakeToolPipelineOptions } from "./src/tool_pipeline.ts";

export type {
  ApprovalGateway,
  ApprovalInfo,
  ApprovalOutcome,
  ApprovalRequest,
  EventInput,
  EventLog,
  RunTurnDeps,
  ToolCallRequest,
  ToolMode,
  ToolPipeline,
  ToolRunContext,
  ToolRunResult,
} from "./src/deps.ts";
