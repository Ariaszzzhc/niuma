import { join } from "@std/path";
import {
  parseEventLine,
  type RecordedEvent,
  SCHEMA_VERSION,
  stringifyEventLine,
} from "@niuma/schema";
import { log } from "./logger.ts";

export interface EventLog {
  readonly append: (event: RecordedEvent) => Promise<RecordedEvent>;
  readonly replay: (
    sessionId: string,
    fromSeq?: number,
  ) => AsyncIterable<RecordedEvent>;
  readonly listSessions: () => Promise<string[]>;
  readonly lastSeq: (sessionId: string) => Promise<number>;
  readonly rebuildProjection: (
    sessionId: string,
    apply: (event: RecordedEvent) => Promise<void>,
  ) => Promise<number>;
}

export interface EventLogOptions {
  readonly sessionsDir: string;
  readonly now?: () => number;
}

const ensureDir = async (dir: string): Promise<void> => {
  await Deno.mkdir(dir, { recursive: true });
};

const pathFor = (dir: string, sessionId: string): string =>
  join(dir, `${sessionId}.jsonl`);

const isSafeId = (id: string): boolean => /^[a-zA-Z0-9_-]{1,128}$/.test(id);

export const makeEventLog = (opts: EventLogOptions): EventLog => {
  const { sessionsDir } = opts;
  const now = opts.now ?? (() => Date.now());
  const logger = log("niuma.server.eventlog");

  const append: EventLog["append"] = async (raw) => {
    if (!isSafeId(raw.sessionId)) {
      throw new Error(`unsafe sessionId: ${raw.sessionId}`);
    }
    await ensureDir(sessionsDir);
    const enriched: RecordedEvent = {
      ...raw,
      ts: raw.ts ?? now(),
    };
    const line = stringifyEventLine(enriched) + "\n";
    const path = pathFor(sessionsDir, raw.sessionId);
    await Deno.writeTextFile(path, line, { append: true });
    return enriched;
  };

  const replay: EventLog["replay"] = async function* (
    sessionId: string,
    fromSeq = 0,
  ): AsyncIterable<RecordedEvent> {
    if (!isSafeId(sessionId)) {
      throw new Error(`unsafe sessionId: ${sessionId}`);
    }
    const path = pathFor(sessionsDir, sessionId);
    let fh: Deno.FsFile | null = null;
    try {
      fh = await Deno.open(path, { read: true });
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return;
      throw e;
    }
    if (!fh) return;
    try {
      const decoder = new TextDecoder();
      let pending = "";
      while (true) {
        const chunk = new Uint8Array(64 * 1024);
        const n = await fh.read(chunk);
        if (n === null || n === 0) break;
        pending += decoder.decode(chunk.subarray(0, n), { stream: true });
        let nl: number;
        while ((nl = pending.indexOf("\n")) !== -1) {
          const raw_line = pending.slice(0, nl);
          pending = pending.slice(nl + 1);
          if (raw_line.length === 0) continue;
          try {
            const evt = parseEventLine(raw_line);
            if (evt.seq >= fromSeq) yield evt;
          } catch (e) {
            logger.warn("malformed jsonl line skipped: {err}", {
              err: String(e),
            });
          }
        }
      }
      // flush any trailing partial line
      if (pending.trim().length > 0) {
        try {
          const evt = parseEventLine(pending);
          if (evt.seq >= fromSeq) yield evt;
        } catch {
          // ignore trailing garbage
        }
      }
    } finally {
      try {
        fh.close();
      } catch {
        // ignored
      }
    }
  };

  const listSessions: EventLog["listSessions"] = async () => {
    try {
      const entries: Deno.DirEntry[] = [];
      for await (const e of Deno.readDir(sessionsDir)) {
        if (e.isFile && e.name.endsWith(".jsonl")) {
          entries.push(e);
        }
      }
      return entries.map((e) => e.name.slice(0, -".jsonl".length)).sort();
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return [];
      throw e;
    }
  };

  const lastSeq: EventLog["lastSeq"] = async (sessionId: string) => {
    if (!isSafeId(sessionId)) return 0;
    const path = pathFor(sessionsDir, sessionId);
    let last = 0;
    try {
      const fh = await Deno.open(path, { read: true });
      try {
        const decoder = new TextDecoder();
        let pending = "";
        while (true) {
          const chunk = new Uint8Array(32 * 1024);
          const n = await fh.read(chunk);
          if (n === null || n === 0) break;
          pending += decoder.decode(chunk.subarray(0, n), { stream: true });
          let nl: number;
          while ((nl = pending.indexOf("\n")) !== -1) {
            const raw_line = pending.slice(0, nl);
            pending = pending.slice(nl + 1);
            if (raw_line.length === 0) continue;
            try {
              const evt = parseEventLine(raw_line);
              if (evt.seq > last) last = evt.seq;
            } catch {
              // skip malformed
            }
          }
        }
      } finally {
        try {
          fh.close();
        } catch {
          // ignored
        }
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
    return last;
  };

  const rebuildProjection: EventLog["rebuildProjection"] = async (
    sessionId,
    apply,
  ): Promise<number> => {
    let count = 0;
    for await (const evt of replay(sessionId, 0)) {
      await apply(evt);
      count += 1;
    }
    logger.info("rebuilt projection for session {id} from {n} events", {
      id: sessionId,
      n: count,
    });
    return count;
  };

  return { append, replay, listSessions, lastSeq, rebuildProjection };
};

export { SCHEMA_VERSION };
