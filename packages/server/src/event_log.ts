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
}

export interface EventLogOptions {
  readonly sessionsDir: string;
  readonly now?: () => number;
  /** Remove derived state after a corrupted source-of-truth log is deleted. */
  readonly onCorrupt?: (sessionId: string) => Promise<void>;
}

export class CorruptSessionError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string, cause: unknown) {
    super(`corrupted event log deleted for session ${sessionId}`, { cause });
    this.name = "CorruptSessionError";
    this.sessionId = sessionId;
  }
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

  const removeCorrupt = async (
    sessionId: string,
    path: string,
    cause: unknown,
  ): Promise<never> => {
    try {
      await Deno.remove(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await opts.onCorrupt?.(sessionId);
    logger.warn("deleted corrupted event log for session {id}: {err}", {
      id: sessionId,
      err: String(cause),
    });
    throw new CorruptSessionError(sessionId, cause);
  };

  const readValidated = async (
    sessionId: string,
  ): Promise<ReadonlyArray<RecordedEvent>> => {
    if (!isSafeId(sessionId)) {
      throw new Error(`unsafe sessionId: ${sessionId}`);
    }
    const path = pathFor(sessionsDir, sessionId);
    let bytes: Uint8Array;
    try {
      bytes = await Deno.readFile(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return [];
      throw error;
    }

    try {
      if (bytes.length === 0) {
        throw new Error("event log is empty");
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!text.endsWith("\n")) {
        throw new Error("event log has a truncated final line");
      }

      const lines = text.slice(0, -1).split("\n");
      const events: RecordedEvent[] = [];
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (line.length === 0) {
          throw new Error(`event log contains an empty line at ${index + 1}`);
        }
        const event = parseEventLine(line);
        if (event.sessionId !== sessionId) {
          throw new Error(
            `event log line ${index + 1} belongs to ${event.sessionId}`,
          );
        }
        const expectedSeq = index + 1;
        if (!Number.isSafeInteger(event.seq) || event.seq !== expectedSeq) {
          throw new Error(
            `event log line ${
              index + 1
            } has seq ${event.seq}; expected ${expectedSeq}`,
          );
        }
        events.push(event);
      }
      return events;
    } catch (error) {
      return await removeCorrupt(sessionId, path, error);
    }
  };

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
    const events = await readValidated(sessionId);
    for (const event of events) {
      if (event.seq >= fromSeq) yield event;
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
    const events = await readValidated(sessionId);
    return events.at(-1)?.seq ?? 0;
  };

  return { append, replay, listSessions, lastSeq };
};

export { SCHEMA_VERSION };
