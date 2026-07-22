export const TOOLS_VERSION = "0.0.0";

// ---- Public surface ----
export type {
  Accesses,
  ApprovalDecision,
  ApprovalInfo,
  FileAccess,
  JsonSchemaObject,
  PermissionEngine,
  PreparedCall,
  SubagentResult,
  Tool,
  ToolCallRecord,
  ToolCtx,
  ToolDefLike,
  ToolMode,
  ToolOutput,
} from "./src/types.ts";
export { READ_ONLY_ALLOWED } from "./src/types.ts";
export {
  makeEngine,
  matchWildcard,
  MemoryPermissionEngine,
} from "./src/permission.ts";
export {
  FILE_TOOLS,
  isSensitivePath,
  READ_ONLY_TOOLS,
  runPolicy,
} from "./src/permission.ts";
export type { Verdict } from "./src/permission.ts";
export { authorize } from "./src/authorize.ts";
export type { AuthorizeContext } from "./src/authorize.ts";
export { runPipeline } from "./src/pipeline.ts";
export type { PipelineOptions } from "./src/pipeline.ts";
export { schedule } from "./src/scheduler.ts";
export type { ScheduledJob, SchedulerOptions } from "./src/scheduler.ts";
export {
  dataDir,
  outputDir,
  safeCallId,
  toolOutput,
  truncateForModel,
} from "./src/truncate.ts";
export type { TruncateResult } from "./src/truncate.ts";
export { resolvePath, PathError } from "./src/path.ts";
export type { ResolvedPath } from "./src/path.ts";
export {
  ALWAYS_IGNORE_DIRS,
  conflicts,
  isWithinRoot,
  resolveWithinRoot,
  shouldSkipDir,
} from "./src/pathUtil.ts";
export { zodToJsonSchema } from "./src/jsonSchema.ts";
export { ToolRegistry, builtins, toToolMap } from "./src/registry.ts";

// ---- Agent-port adapter (satisfies @niuma/agent's ToolPipeline) ----
export { makeToolPipeline } from "./src/adapter.ts";
export type {
  ApprovalDecisionType,
  ApprovalOutcome,
  ApprovalRequest,
  MakeToolPipelineOptions,
  SpawnSubagentFn,
  ToolCallRequest as AgentToolCallRequest,
  ToolPipeline,
  ToolRunContext,
  ToolRunResult,
} from "./src/adapter.ts";

// ---- Built-in tools (named exports for direct use + tests) ----
export { bashTool, BashInput } from "./src/tools/bash.ts";
export { readTool, ReadInput } from "./src/tools/read.ts";
export { writeTool, WriteInput } from "./src/tools/write.ts";
export { editTool, EditInput } from "./src/tools/edit.ts";
export { applyPatchTool, ApplyPatchInput, parsePatch } from "./src/tools/apply_patch.ts";
export { grepTool, GrepInput } from "./src/tools/grep.ts";
export { globTool, GlobInput } from "./src/tools/glob.ts";
export { updatePlanTool, UpdatePlanInput, getPlan } from "./src/tools/update_plan.ts";
export { questionTool, QuestionInput } from "./src/tools/question.ts";
export { spawnSubagentTool, SpawnSubagentInput } from "./src/tools/spawn_subagent.ts";