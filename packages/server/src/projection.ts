import {
  type ApprovalResolvedData,
  type RecordedEvent,
  type SessionInfo,
  type StopReason,
} from "@niuma/schema";
import { Kysely, sql } from "kysely";
import { createNodeSqliteDialect } from "@niuma/store/vendor/node-sqlite-dialect.ts";
import { log } from "./logger.ts";

interface SessionRow {
  session_id: string;
  workspace: string;
  model: string;
  created_at: number;
  updated_at: number;
  status: string;
  last_stop_reason: string | null;
  message_count: number;
}

interface EventRow {
  session_id: string;
  seq: number;
  ts: number;
  type: string;
  payload: string;
}

interface ApprovalRow {
  approval_id: string;
  session_id: string;
  call_id: string;
  name: string;
  input_json: string;
  status: string;
  decision: string | null;
  feedback: string | null;
  ts: number;
  resolved_ts: number | null;
}

interface NiumaDB {
  sessions: SessionRow;
  events: EventRow;
  approvals: ApprovalRow;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id        TEXT PRIMARY KEY,
  workspace         TEXT NOT NULL,
  model             TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  status            TEXT NOT NULL,
  last_stop_reason  TEXT,
  message_count     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  session_id        TEXT NOT NULL,
  seq               INTEGER NOT NULL,
  ts                INTEGER NOT NULL,
  type              TEXT NOT NULL,
  payload           TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE TABLE IF NOT EXISTS approvals (
  approval_id       TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL,
  call_id           TEXT NOT NULL,
  name              TEXT NOT NULL,
  input_json        TEXT NOT NULL,
  status            TEXT NOT NULL,
  decision          TEXT,
  feedback          TEXT,
  ts                INTEGER NOT NULL,
  resolved_ts       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_approvals_session ON approvals(session_id);
`;

const fromRow = (r: SessionRow): SessionInfo => ({
  sessionId: r.session_id,
  workspace: r.workspace,
  model: r.model,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  status: r.status as SessionInfo["status"],
  ...(r.last_stop_reason
    ? { lastStopReason: r.last_stop_reason as StopReason }
    : {}),
  messageCount: r.message_count,
});

export interface Projection {
  readonly db: Kysely<NiumaDB>;
  readonly apply: (event: RecordedEvent) => Promise<void>;
  readonly listSessions: () => Promise<SessionInfo[]>;
  readonly getSession: (id: string) => Promise<SessionInfo | undefined>;
  readonly getApproval: (id: string) => Promise<ApprovalRow | undefined>;
  readonly getMessageCount: (id: string) => Promise<number>;
  readonly resetSession: (id: string) => Promise<void>;
  readonly close: () => void;
}

export const makeProjection = (dbPath: string): Projection => {
  const dialect = createNodeSqliteDialect(dbPath);
  const db = new Kysely<NiumaDB>({ dialect });

  const apply: Projection["apply"] = async (event) => {
    const payload = JSON.stringify(event);
    const ts = event.ts;
    const seq = event.seq;
    const sid = event.sessionId;

    switch (event.type) {
      case "session.created": {
        await db
          .insertInto("sessions")
          .values({
            session_id: sid,
            workspace: event.data.workspace,
            model: event.data.model,
            created_at: ts,
            updated_at: ts,
            status: "idle",
            last_stop_reason: null,
            message_count: 0,
          })
          .onConflict((oc) =>
            oc.column("session_id").doUpdateSet({ updated_at: ts })
          )
          .execute();
        break;
      }
      case "user.message":
      case "assistant.message": {
        const inc = event.type === "user.message" ? 1 : 1;
        await db
          .updateTable("sessions")
          .set({
            updated_at: ts,
            message_count: sql`message_count + ${inc}`,
          })
          .where("session_id", "=", sid)
          .execute();
        break;
      }
      case "turn.started": {
        await db
          .updateTable("sessions")
          .set({ status: "running", updated_at: ts })
          .where("session_id", "=", sid)
          .execute();
        break;
      }
      case "turn.completed": {
        await db
          .updateTable("sessions")
          .set({
            status: "idle",
            updated_at: ts,
            last_stop_reason: event.data.stopReason,
          })
          .where("session_id", "=", sid)
          .execute();
        break;
      }
      case "turn.aborted": {
        await db
          .updateTable("sessions")
          .set({ status: "aborted", updated_at: ts })
          .where("session_id", "=", sid)
          .execute();
        break;
      }
      case "approval.requested": {
        await db
          .insertInto("approvals")
          .values({
            approval_id: event.data.approvalId,
            session_id: sid,
            call_id: event.data.callId,
            name: event.data.name,
            input_json: JSON.stringify(event.data.input ?? {}),
            status: "pending",
            decision: null,
            feedback: null,
            ts,
            resolved_ts: null,
          })
          .onConflict((oc) =>
            oc.column("approval_id").doUpdateSet({
              status: "pending",
              resolved_ts: null,
              decision: null,
              feedback: null,
              ts,
            })
          )
          .execute();
        await db
          .updateTable("sessions")
          .set({ status: "waiting_approval", updated_at: ts })
          .where("session_id", "=", sid)
          .execute();
        break;
      }
      case "approval.resolved": {
        const d = event.data as ApprovalResolvedData;
        await db
          .updateTable("approvals")
          .set({
            status: "resolved",
            decision: d.decision,
            feedback: d.feedback ?? null,
            resolved_ts: ts,
          })
          .where("approval_id", "=", d.approvalId)
          .execute();
        await db
          .updateTable("sessions")
          .set({ status: "running", updated_at: ts })
          .where("session_id", "=", sid)
          .execute();
        break;
      }
      case "error.occurred": {
        await db
          .updateTable("sessions")
          .set({ updated_at: ts })
          .where("session_id", "=", sid)
          .execute();
        break;
      }
      default:
        // Other event types update the timestamp only.
        await db
          .updateTable("sessions")
          .set({ updated_at: ts })
          .where("session_id", "=", sid)
          .execute();
        break;
    }

    // Always record the event envelope for the audit/history projection.
    await db
      .insertInto("events")
      .values({
        session_id: sid,
        seq,
        ts,
        type: event.type,
        payload,
      })
      .onConflict((oc) => oc.columns(["session_id", "seq"]).doNothing())
      .execute();
  };

  const listSessions: Projection["listSessions"] = async () => {
    const rows = await db
      .selectFrom("sessions")
      .selectAll()
      .orderBy("updated_at", "desc")
      .execute();
    return rows.map(fromRow);
  };

  const getSession: Projection["getSession"] = async (id) => {
    const row = await db
      .selectFrom("sessions")
      .selectAll()
      .where("session_id", "=", id)
      .executeTakeFirst();
    return row ? fromRow(row) : undefined;
  };

  const getApproval: Projection["getApproval"] = async (id) =>
    await db
      .selectFrom("approvals")
      .selectAll()
      .where("approval_id", "=", id)
      .executeTakeFirst();

  const getMessageCount: Projection["getMessageCount"] = async (id) => {
    const row = await db
      .selectFrom("sessions")
      .select("message_count")
      .where("session_id", "=", id)
      .executeTakeFirst();
    return row?.message_count ?? 0;
  };

  const resetSession: Projection["resetSession"] = async (id) => {
    await db.deleteFrom("events").where("session_id", "=", id).execute();
    await db.deleteFrom("approvals").where("session_id", "=", id).execute();
    await db.deleteFrom("sessions").where("session_id", "=", id).execute();
  };

  const close = (): void => {
    try {
      db.destroy();
    } catch (e) {
      log("niuma.server.projection").warn("projection close: {err}", {
        err: String(e),
      });
    }
  };

  return {
    db,
    apply,
    listSessions,
    getSession,
    getApproval,
    getMessageCount,
    resetSession,
    close,
  };
};

export const ensureSchema = async (dbPath: string): Promise<Projection> => {
  const p = makeProjection(dbPath);
  // Split on `;` to get individual statements. node:sqlite supports multiple
  // statements in one exec call, but Kysely's sql tag executes one at a time.
  const stmts = SCHEMA_SQL.split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of stmts) {
    await sql`${sql.raw(stmt)}`.execute(p.db);
  }
  return p;
};