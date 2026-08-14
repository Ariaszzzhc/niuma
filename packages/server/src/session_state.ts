// SessionState is the pure fold of one Session Journal. It is the only place
// that defines how recorded events become the resumable Session read model.

import type {
  ApprovalRequestedData,
  McpServerStatus,
  RecordedEvent,
  SessionInfo,
  StopReason,
} from "@niuma/schema";

export interface SessionState {
  readonly info: SessionInfo;
  readonly contextWindow?: number;
  readonly mcpServers: ReadonlyArray<McpServerStatus>;
  readonly effort?: string;
  readonly activeTurnId?: string;
  readonly pendingApprovals: ReadonlyMap<string, ApprovalRequestedData>;
}

export class InvalidSessionJournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSessionJournalError";
  }
}

const firstUserText = (
  event: Extract<RecordedEvent, { type: "user.message" }>,
): string | undefined => {
  const sourceText = event.data.sourceText?.trim();
  if (sourceText) return sourceText.slice(0, 120);
  for (const part of event.data.parts) {
    if (part.type !== "text") continue;
    const text = part.text.trim();
    if (text) return text.slice(0, 120);
  }
  return undefined;
};

export const foldSessionState = (
  events: ReadonlyArray<RecordedEvent>,
): SessionState => {
  const created = events[0];
  if (created?.type !== "session.created") {
    throw new InvalidSessionJournalError(
      "Session Journal must start with session.created",
    );
  }

  const sessionId = created.sessionId;
  let model = created.data.model;
  let effort = created.data.effort;
  let contextWindow = created.data.contextWindow;
  let updatedAt = created.ts;
  let status: SessionInfo["status"] = "idle";
  let lastStopReason: StopReason | undefined;
  let title: string | undefined;
  let activeTurnId: string | undefined;
  const pendingApprovals = new Map<string, ApprovalRequestedData>();

  for (const event of events) {
    if (event.sessionId !== sessionId) {
      throw new InvalidSessionJournalError(
        `Session Journal mixes ${sessionId} and ${event.sessionId}`,
      );
    }
    updatedAt = event.ts;
    switch (event.type) {
      case "session.created":
        if (event !== created) {
          throw new InvalidSessionJournalError(
            "Session Journal contains multiple session.created events",
          );
        }
        break;
      case "session.model.changed":
        model = event.data.model;
        contextWindow = event.data.contextWindow;
        break;
      case "session.effort.changed":
        effort = event.data.effort;
        break;
      case "session.title.changed":
        title = event.data.title;
        break;
      case "user.message":
        title ??= firstUserText(event);
        break;
      case "turn.started":
        activeTurnId = event.data.turnId;
        status = "running";
        break;
      case "approval.requested":
        pendingApprovals.set(event.data.approvalId, event.data);
        status = "waiting_approval";
        break;
      case "approval.resolved":
        pendingApprovals.delete(event.data.approvalId);
        status = pendingApprovals.size > 0
          ? "waiting_approval"
          : activeTurnId
          ? "running"
          : "idle";
        break;
      case "turn.completed":
        if (activeTurnId === event.data.turnId) activeTurnId = undefined;
        pendingApprovals.clear();
        status = "idle";
        lastStopReason = event.data.stopReason;
        break;
      case "turn.aborted":
        if (activeTurnId === event.data.turnId) activeTurnId = undefined;
        pendingApprovals.clear();
        status = "idle";
        lastStopReason = "abort";
        break;
      default:
        break;
    }
  }

  return {
    info: {
      sessionId,
      workspace: created.data.workspace,
      model,
      ...(effort !== undefined ? { effort } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      createdAt: created.ts,
      updatedAt,
      status,
      ...(lastStopReason !== undefined ? { lastStopReason } : {}),
      ...(title !== undefined ? { title } : {}),
    },
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    mcpServers: created.data.mcpServers,
    ...(effort !== undefined ? { effort } : {}),
    ...(activeTurnId !== undefined ? { activeTurnId } : {}),
    pendingApprovals,
  };
};
