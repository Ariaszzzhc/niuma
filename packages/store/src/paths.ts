import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";

// Honour NIUMA_DATA_DIR the same way packages/server/src/paths.ts does, so
// sessions/*.jsonl, niuma.db and tool-output spills all share one root.
export const DEFAULT_DATA_DIR: string =
  Deno.env.get("NIUMA_DATA_DIR") ||
  join(Deno.env.get("HOME") ?? "", ".config", "niuma");

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
