import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import { niumaPaths } from "@niuma/config";

// Honour NIUMA_DATA_DIR via packages/config/src/paths.ts, so sessions/*.jsonl,
// niuma.db and tool-output spills all share one root (~/.niuma by default).
export const DEFAULT_DATA_DIR: string = niumaPaths().data;

export const DEFAULT_SESSIONS_DIR = join(DEFAULT_DATA_DIR, "sessions");
export const DEFAULT_DB_PATH = join(DEFAULT_DATA_DIR, "niuma.db");

export function sessionsDir(dataDir: string = DEFAULT_DATA_DIR): string {
  return join(dataDir, "sessions");
}

export function dbPath(dataDir: string = DEFAULT_DATA_DIR): string {
  return join(dataDir, "niuma.db");
}

export function sessionFilePath(
  sessionId: string,
  dataDir: string = DEFAULT_DATA_DIR,
): string {
  return join(dataDir, "sessions", `${sessionId}.jsonl`);
}

export function ensureDataDirSync(dataDir: string = DEFAULT_DATA_DIR): void {
  ensureDirSync(dataDir);
  ensureDirSync(join(dataDir, "sessions"));
  ensureDirSync(join(dataDir, "output"));
}

export function pathExistsSync(p: string): boolean {
  try {
    Deno.statSync(p);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}
