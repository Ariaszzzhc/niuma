import type { SessionStatus, StopReason } from "@niuma/schema";

export interface SessionsTable {
  id: string;
  workspace: string;
  model: string;
  created_at: number;
  last_event_at: number;
  status: SessionStatus;
  title: string | null;
  last_stop_reason: StopReason | null;
  message_count: number;
}

export interface SessionSeqTable {
  session_id: string;
  last_seq: number;
}

export interface NiumaDB {
  sessions: SessionsTable;
  session_seq: SessionSeqTable;
}
