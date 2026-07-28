// Retention applies one optional age policy to the current Workspace. For
// every expired Session it durably verifies a content-free Usage Archive
// before deleting the Session Journal.

import type { SessionStore } from "./session_store.ts";
import type { UsageArchive } from "./usage_archive.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface RetentionFailure {
  readonly sessionId: string;
  readonly error: string;
}

export interface RetentionSweepResult {
  readonly inspected: number;
  readonly archived: number;
  readonly deleted: number;
  readonly skippedFresh: number;
  readonly skippedActive: number;
  readonly failures: ReadonlyArray<RetentionFailure>;
}

export interface Retention {
  readonly sweep: () => Promise<RetentionSweepResult>;
}

export interface RetentionOptions {
  readonly store: SessionStore;
  readonly archive: UsageArchive;
  readonly retentionDays: number;
  readonly now?: () => number;
  readonly isSessionActive?: (sessionId: string) => Promise<boolean>;
}

export const makeRetention = (opts: RetentionOptions): Retention => {
  if (
    !Number.isSafeInteger(opts.retentionDays) || opts.retentionDays <= 0
  ) {
    throw new Error("retentionDays must be a positive integer");
  }
  const now = opts.now ?? (() => Date.now());
  const isSessionActive = opts.isSessionActive ??
    (() => Promise.resolve(false));

  const sweep = async (): Promise<RetentionSweepResult> => {
    const ids = await opts.store.listIds();
    const cutoffMs = now() - opts.retentionDays * DAY_MS;
    let archived = 0;
    let deleted = 0;
    let skippedFresh = 0;
    let skippedActive = 0;
    const failures: RetentionFailure[] = [];

    for (const sessionId of ids) {
      try {
        const stat = await Deno.stat(opts.store.pathFor(sessionId));
        const mtime = stat.mtime?.getTime();
        if (mtime === undefined || mtime > cutoffMs) {
          skippedFresh += 1;
          continue;
        }
        if (await isSessionActive(sessionId)) {
          skippedActive += 1;
          continue;
        }

        const events = await opts.store.read(sessionId);
        if (events === undefined) continue;
        await opts.archive.archive(sessionId, events);
        archived += 1;

        // Recheck activity after the potentially slow archive write. The
        // Journal remains available if a Client resumed in the meantime.
        if (await isSessionActive(sessionId)) {
          skippedActive += 1;
          continue;
        }
        if (await opts.store.removeOlderThan(sessionId, cutoffMs)) {
          deleted += 1;
        } else {
          skippedFresh += 1;
        }
      } catch (error) {
        failures.push({
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      inspected: ids.length,
      archived,
      deleted,
      skippedFresh,
      skippedActive,
      failures,
    };
  };

  return { sweep };
};
