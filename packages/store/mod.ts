export * from "./vendor/node-sqlite-dialect.ts";

export {
  DEFAULT_DATA_DIR,
  DEFAULT_DB_PATH,
  DEFAULT_SESSIONS_DIR,
  dbPath,
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

export type { SessionsTable, SessionSeqTable, NiumaDB } from "./src/db.ts";
