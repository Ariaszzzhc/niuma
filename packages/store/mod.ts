export * from "./vendor/node-sqlite-dialect.ts";

export {
  dbPath,
  DEFAULT_DATA_DIR,
  DEFAULT_DB_PATH,
  DEFAULT_SESSIONS_DIR,
  ensureDataDirSync,
  pathExistsSync,
  sessionFilePath,
  sessionsDir,
} from "./src/paths.ts";

export { EventLog } from "./src/event_log.ts";
export type { NewEvent } from "./src/event_log.ts";

export { Projection } from "./src/projection.ts";

export {
  EventLogService,
  EventLogServiceLive,
  ProjectionService,
  ProjectionServiceLive,
} from "./src/services.ts";
export type {
  EventLogServiceShape,
  ProjectionServiceShape,
} from "./src/services.ts";

export type { NiumaDB, SessionSeqTable, SessionsTable } from "./src/db.ts";
