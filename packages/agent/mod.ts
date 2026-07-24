export { runTurn } from "./src/loop.ts";
export type { TurnResult } from "./src/loop.ts";

export { AgentSession, SessionManager } from "./src/session.ts";
export type { AgentInfra, SessionOptions } from "./src/session.ts";

export { makeApprovalGateway } from "./src/approval.ts";

export { buildSystemPrompt, environmentContext } from "./src/prompt.ts";
export {
  ABORTED_TOOL_OUTPUT,
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
  summarizeHistory,
  SUMMARY_PREFIX,
} from "./src/compaction.ts";
export type { SummarizeDeps } from "./src/compaction.ts";
export { makeToolPipeline } from "./src/tool-pipeline.ts";
export type { MakeToolPipelineOptions } from "./src/tool-pipeline.ts";

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
