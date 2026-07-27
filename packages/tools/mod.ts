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
export { PathError, resolvePath } from "./src/path.ts";
export type { ResolvedPath } from "./src/path.ts";
export {
  ALWAYS_IGNORE_DIRS,
  conflicts,
  isWithinRoot,
  resolveWithinRoot,
  shouldSkipDir,
} from "./src/path_util.ts";
export { zodToJsonSchema } from "./src/json_schema.ts";
export { builtins, ToolRegistry } from "./src/registry.ts";

// ---- Built-in tools (named exports for direct use + tests) ----
export { BashInput, bashTool } from "./src/tools/bash.ts";
export { ReadInput, readTool } from "./src/tools/read.ts";
export { WriteInput, writeTool } from "./src/tools/write.ts";
export { EditInput, editTool } from "./src/tools/edit.ts";
export {
  ApplyPatchInput,
  applyPatchTool,
  parsePatch,
} from "./src/tools/apply_patch.ts";
export { GrepInput, grepTool } from "./src/tools/grep.ts";
export { GlobInput, globTool } from "./src/tools/glob.ts";
export { UpdatePlanInput, updatePlanTool } from "./src/tools/update_plan.ts";
export { QuestionInput, questionTool } from "./src/tools/question.ts";
export {
  SpawnSubagentInput,
  spawnSubagentTool,
} from "./src/tools/spawn_subagent.ts";
