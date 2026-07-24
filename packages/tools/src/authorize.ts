import type { PermissionRule } from "@niuma/schema";
import type {
  AuthorizeOutcome,
  Decision,
  PermissionEngine,
  PreparedCall,
  Tool,
  ToolCtx,
} from "./types.ts";

export interface AuthorizeContext {
  engine: PermissionEngine;
  ctx: ToolCtx;
}

/**
 * Drive the authorization half of the pipeline. Returns either a clean
 * `decision` (allow/deny) or an Ask outcome that was already resolved with
 * the user — in which case we return a synthetic `Allow` (with the
 * remembered rule) or `Deny`.
 *
 * The contract: this function never throws. Ask → resolved synchronously
 * via `ctx.ask`; once/always/reject becomes allow/allow-with-rule/deny.
 *
 * Escape handling: if `prepare` flagged any resolved path as escaping the
 * workspace root, we FORCE Ask even when the engine verdict was `allow` —
 * the user must explicitly bless each escape.
 */
export async function authorize(
  call: PreparedCall,
  tools: ReadonlyMap<string, Tool>,
  auth: AuthorizeContext,
): Promise<
  { verdict: "allow" | "deny"; reason?: string; rule?: PermissionRule }
> {
  const decision: Decision = await auth.engine.evaluate({
    callId: call.callId,
    sessionId: auth.ctx.sessionId,
    name: call.name,
    pattern: call.pattern,
  });

  // Force Ask on workspace escapes, overriding any `allow` verdict.
  const effective: Decision =
    call.escapesWorkspace && decision.decision === "allow"
      ? { decision: "ask" }
      : decision;

  if (effective.decision === "allow") {
    return { verdict: "allow" };
  }
  if (effective.decision === "deny") {
    return { verdict: "deny", reason: effective.reason ?? "denied by policy" };
  }

  // ask → ask the user
  const tool = tools.get(call.name);
  const summary = tool
    ? describeToolCall(tool, call)
    : `${call.name}(${call.pattern})`;
  const approvalInfo = {
    callId: call.callId,
    name: call.name,
    summary,
    pattern: call.pattern,
    sensitive: isSensitive(call),
    detail: call.pattern,
  };
  const reply = await auth.ctx.ask(approvalInfo);

  if (reply.decision === "once") {
    return { verdict: "allow" };
  }
  if (reply.decision === "always") {
    const rule: PermissionRule = {
      tool: call.name,
      pattern: call.pattern,
      action: "allow",
    };
    await auth.engine.remember(rule);
    return { verdict: "allow", rule };
  }
  // reject
  return {
    verdict: "deny",
    reason: reply.feedback ?? "rejected by user",
  };
}

function isSensitive(call: PreparedCall): boolean {
  if (call.accesses.network) return true;
  if (call.accesses.process) return true;
  if (call.escapesWorkspace) return true;
  // Any write counts as sensitive from the user's perspective.
  return (call.accesses.files?.write?.length ?? 0) > 0;
}

function describeToolCall<I>(tool: Tool<I>, call: PreparedCall<I>): string {
  const access = call.accesses;
  if (tool.accesses.process) return `run command: ${call.pattern}`;
  if (tool.accesses.network) return `network call: ${call.pattern}`;
  const write = access.files?.write ?? [];
  if (write.length > 0) return `write ${write.join(", ")}`;
  const read = access.files?.read ?? [];
  if (read.length > 0) return `read ${read.join(", ")}`;
  return `${call.name}(${call.pattern})`;
}

export type { AuthorizeOutcome };
