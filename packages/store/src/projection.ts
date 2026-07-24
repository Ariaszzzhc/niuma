import type {
  RecordedEvent,
  SessionInfo,
  SessionStatus,
  StopReason,
} from "@niuma/schema";
import { Kysely, type Selectable, sql } from "kysely";
import { dbPath, DEFAULT_DATA_DIR, ensureDataDirSync } from "./paths.ts";
import { EventLog } from "./event_log.ts";
import { createNodeSqliteDialect } from "../vendor/node-sqlite-dialect.ts";
import type { NiumaDB, SessionsTable } from "./db.ts";

function toStatus(event: RecordedEvent): SessionStatus {
  switch (event.type) {
    case "session.created":
      return "idle";
    case "turn.started":
      return "running";
    case "approval.requested":
      return "waiting_approval";
    case "approval.resolved":
      return "running";
    case "turn.completed":
      return "idle";
    case "turn.aborted":
      return "aborted";
    case "error.occurred":
      return "aborted";
    default:
      return "running";
  }
}

function firstUserText(event: RecordedEvent): string | null {
  if (event.type !== "user.message") return null;
  for (const p of event.data.parts) {
    if (p.type === "text" && p.text.trim().length > 0) {
      return p.text.slice(0, 120);
    }
  }
  return null;
}

export class Projection {
  readonly db: Kysely<NiumaDB>;
  readonly dataDir: string;

  private constructor(db: Kysely<NiumaDB>, dataDir: string) {
    this.db = db;
    this.dataDir = dataDir;
  }

  static open(dataDir: string = DEFAULT_DATA_DIR): Projection {
    ensureDataDirSync(dataDir);
    const path = dbPath(dataDir);
    const dialect = createNodeSqliteDialect(path);
    const db = new Kysely<NiumaDB>({ dialect });
    return Projection.from(db, dataDir);
  }

  static from(db: Kysely<NiumaDB>, dataDir: string): Projection {
    return new Projection(db, dataDir);
  }

  async migrate(): Promise<void> {
    await this.db.schema
      .createTable("sessions")
      .ifNotExists()
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("workspace", "text", (col) => col.notNull())
      .addColumn("model", "text", (col) => col.notNull())
      .addColumn("created_at", "integer", (col) => col.notNull())
      .addColumn("last_event_at", "integer", (col) => col.notNull())
      .addColumn("status", "text", (col) => col.notNull())
      .addColumn("title", "text")
      .addColumn("last_stop_reason", "text")
      .addColumn(
        "message_count",
        "integer",
        (col) => col.notNull().defaultTo(0),
      )
      .execute();
    await this.db.schema
      .createTable("session_seq")
      .ifNotExists()
      .addColumn("session_id", "text", (col) => col.primaryKey())
      .addColumn("last_seq", "integer", (col) => col.notNull())
      .execute();
  }

  async apply(event: RecordedEvent): Promise<void> {
    await this.db
      .insertInto("session_seq")
      .values({ session_id: event.sessionId, last_seq: event.seq })
      .onConflict((oc) =>
        oc.column("session_id").doUpdateSet({ last_seq: event.seq })
      )
      .execute();

    if (event.type === "session.created") {
      await this.db
        .insertInto("sessions")
        .values({
          id: event.sessionId,
          workspace: event.data.workspace,
          model: event.data.model,
          created_at: event.ts,
          last_event_at: event.ts,
          status: "idle",
          title: null,
          last_stop_reason: null,
          message_count: 0,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
      return;
    }

    const exists = await this.db
      .selectFrom("sessions")
      .select("id")
      .where("id", "=", event.sessionId)
      .executeTakeFirst();
    if (!exists) return;

    const stopReasonValue: StopReason | null = event.type === "turn.completed"
      ? event.data.stopReason
      : null;

    const set: {
      last_event_at: number;
      status: SessionStatus;
      last_stop_reason?: StopReason | null;
    } = {
      last_event_at: event.ts,
      status: toStatus(event),
    };
    if (stopReasonValue !== null) set.last_stop_reason = stopReasonValue;

    await this.db
      .updateTable("sessions")
      .set(set)
      .where("id", "=", event.sessionId)
      .execute();

    // First-user-wins title: only set when the column is currently NULL.
    const candidateTitle = firstUserText(event);
    if (candidateTitle !== null) {
      await sql`
        UPDATE sessions
        SET title = coalesce(title, ${candidateTitle})
        WHERE id = ${event.sessionId}
      `.execute(this.db);
    }

    if (event.type === "user.message") {
      await sql`
        UPDATE sessions
        SET message_count = coalesce(message_count, 0) + 1
        WHERE id = ${event.sessionId}
      `.execute(this.db);
    }
  }

  async rebuildAll(): Promise<void> {
    await this.db.deleteFrom("session_seq").execute();
    await this.db.deleteFrom("sessions").execute();
    const ids = EventLog.listSessionFiles(this.dataDir);
    for (const id of ids) {
      for await (const ev of EventLog.replay(id, this.dataDir)) {
        await this.apply(ev);
      }
    }
  }

  async listSessions(): Promise<SessionInfo[]> {
    const rows = await this.db
      .selectFrom("sessions")
      .selectAll()
      .orderBy("last_event_at", "desc")
      .execute();
    return rows.map(rowToInfo);
  }

  async getSession(id: string): Promise<SessionInfo | null> {
    const row = await this.db
      .selectFrom("sessions")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? rowToInfo(row) : null;
  }

  async close(): Promise<void> {
    await this.db.destroy();
  }
}

function rowToInfo(row: Selectable<SessionsTable>): SessionInfo {
  return {
    sessionId: row.id,
    workspace: row.workspace,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.last_event_at,
    status: row.status,
    lastStopReason: row.last_stop_reason ?? undefined,
    messageCount: row.message_count,
    title: row.title ?? undefined,
  };
}
