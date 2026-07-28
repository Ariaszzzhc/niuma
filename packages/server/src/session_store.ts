// SessionStore owns one Workspace's Session Journals. It assigns event
// metadata, validates/replays JSONL, folds Session State, and performs lazy
// listing without any database or process-wide startup scan.

import { join } from "@std/path";
import {
  parseEventLine,
  type RecordedEvent,
  stringifyEventLine,
} from "@niuma/schema";
import { log } from "./logger.ts";
import { foldSessionState, type SessionState } from "./session_state.ts";
import type { WorkspaceLayout } from "./workspace_layout.ts";

type WithoutSeqTs<T> = T extends unknown ? Omit<T, "seq" | "ts"> : never;
export type SessionEventInput = WithoutSeqTs<RecordedEvent> & {
  readonly sessionId: string;
  readonly ts?: number;
};

export interface SessionStore {
  readonly workspace: string;
  readonly sessionsDir: string;
  readonly append: (input: SessionEventInput) => Promise<RecordedEvent>;
  readonly replay: (
    sessionId: string,
    fromSeq?: number,
  ) => AsyncIterable<RecordedEvent>;
  readonly read: (
    sessionId: string,
  ) => Promise<ReadonlyArray<RecordedEvent> | undefined>;
  readonly state: (sessionId: string) => Promise<SessionState | undefined>;
  readonly listRecent: (limit?: number) => Promise<ReadonlyArray<SessionState>>;
  readonly listIds: () => Promise<ReadonlyArray<string>>;
  readonly lastSeq: (sessionId: string) => Promise<number>;
  /** Mark a Session as recently used; false when Retention already removed it. */
  readonly touch: (sessionId: string) => Promise<boolean>;
  readonly remove: (sessionId: string) => Promise<void>;
  /** Delete only when the Journal is still at or older than the Retention
   * cutoff. Serialized with append/touch to close the resume-vs-cleanup race. */
  readonly removeOlderThan: (
    sessionId: string,
    cutoffMs: number,
  ) => Promise<boolean>;
  readonly pathFor: (sessionId: string) => string;
}

export interface SessionStoreOptions {
  readonly layout: WorkspaceLayout;
  readonly now?: () => number;
}

export class CorruptSessionError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string, cause: unknown) {
    super(`corrupted Session Journal deleted for session ${sessionId}`, {
      cause,
    });
    this.name = "CorruptSessionError";
    this.sessionId = sessionId;
  }
}

const isSafeId = (id: string): boolean => /^[a-zA-Z0-9_-]{1,128}$/.test(id);

const writeAll = async (
  file: Deno.FsFile,
  bytes: Uint8Array,
): Promise<void> => {
  let offset = 0;
  while (offset < bytes.length) {
    offset += await file.write(bytes.subarray(offset));
  }
};

export const makeSessionStore = (opts: SessionStoreOptions): SessionStore => {
  const { layout } = opts;
  const now = opts.now ?? (() => Date.now());
  const logger = log("niuma.server.session_store");
  const seqBySession = new Map<string, number>();
  const sessionTails = new Map<string, Promise<void>>();

  const pathFor = (sessionId: string): string => {
    if (!isSafeId(sessionId)) {
      throw new Error(`unsafe sessionId: ${sessionId}`);
    }
    return join(layout.sessions, `${sessionId}.jsonl`);
  };

  const removeCorrupt = async (
    sessionId: string,
    path: string,
    cause: unknown,
  ): Promise<never> => {
    seqBySession.delete(sessionId);
    try {
      await Deno.remove(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    logger.warn("deleted corrupted Session Journal for {id}: {err}", {
      id: sessionId,
      err: String(cause),
    });
    throw new CorruptSessionError(sessionId, cause);
  };

  const readValidatedUnlocked = async (
    sessionId: string,
  ): Promise<ReadonlyArray<RecordedEvent> | undefined> => {
    const path = pathFor(sessionId);
    let bytes: Uint8Array;
    try {
      bytes = await Deno.readFile(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    }

    try {
      if (bytes.length === 0) {
        throw new Error("Session Journal is empty");
      }

      // A crash can leave only the final append incomplete. Everything
      // through the last newline is durable and independently validated; the
      // incomplete suffix is discarded instead of deleting the whole Session.
      if (bytes.at(-1) !== 0x0a) {
        const lastNewline = bytes.lastIndexOf(0x0a);
        if (lastNewline < 0) {
          throw new Error("Session Journal has no complete line");
        }
        const durableLength = lastNewline + 1;
        await Deno.truncate(path, durableLength);
        bytes = bytes.slice(0, durableLength);
      }

      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const lines = text.slice(0, -1).split("\n");
      const events: RecordedEvent[] = [];
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (line.length === 0) {
          throw new Error(
            `Session Journal contains an empty line at ${index + 1}`,
          );
        }
        const event = parseEventLine(line);
        if (event.sessionId !== sessionId) {
          throw new Error(
            `Session Journal line ${index + 1} belongs to ${event.sessionId}`,
          );
        }
        const expectedSeq = index + 1;
        if (!Number.isSafeInteger(event.seq) || event.seq !== expectedSeq) {
          throw new Error(
            `Session Journal line ${
              index + 1
            } has seq ${event.seq}; expected ${expectedSeq}`,
          );
        }
        events.push(event);
      }
      if (events[0]?.type !== "session.created") {
        throw new Error("Session Journal must start with session.created");
      }
      if (events[0].data.workspace !== layout.workspace) {
        throw new Error(
          `Session Journal belongs to ${
            events[0].data.workspace
          }, not ${layout.workspace}`,
        );
      }
      seqBySession.set(sessionId, events.length);
      return events;
    } catch (error) {
      return await removeCorrupt(sessionId, path, error);
    }
  };

  const withSessionLock = async <A>(
    sessionId: string,
    action: () => Promise<A>,
  ): Promise<A> => {
    const previous = sessionTails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    sessionTails.set(sessionId, tail);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (sessionTails.get(sessionId) === tail) {
        sessionTails.delete(sessionId);
      }
    }
  };

  // Reads share the Session-local lock with append/touch/removal. Otherwise a
  // replay could observe an in-progress final write, mistake it for a crashed
  // append, and truncate bytes that the writer still owns.
  const readValidated = (
    sessionId: string,
  ): Promise<ReadonlyArray<RecordedEvent> | undefined> =>
    withSessionLock(sessionId, () => readValidatedUnlocked(sessionId));

  const append: SessionStore["append"] = (input) =>
    withSessionLock(input.sessionId, async () => {
      await Deno.mkdir(layout.sessions, { recursive: true });
      let current = seqBySession.get(input.sessionId);
      if (current === undefined) {
        current = (await readValidatedUnlocked(input.sessionId))?.length ?? 0;
      }
      if (current === 0 && input.type !== "session.created") {
        throw new Error(
          `first event for ${input.sessionId} must be session.created`,
        );
      }
      if (current > 0 && input.type === "session.created") {
        throw new Error(`session ${input.sessionId} already exists`);
      }
      if (
        input.type === "session.created" &&
        input.data.workspace !== layout.workspace
      ) {
        throw new Error(
          `session workspace ${input.data.workspace} does not match ${layout.workspace}`,
        );
      }

      const event = {
        ...input,
        seq: current + 1,
        ts: input.ts ?? now(),
      } as RecordedEvent;
      const bytes = new TextEncoder().encode(
        `${stringifyEventLine(event)}\n`,
      );
      const file = await Deno.open(pathFor(input.sessionId), {
        create: true,
        write: true,
        append: true,
      });
      try {
        await writeAll(file, bytes);
        await file.sync();
      } finally {
        file.close();
      }
      seqBySession.set(input.sessionId, event.seq);
      return event;
    });

  const replay: SessionStore["replay"] = async function* (
    sessionId,
    fromSeq = 0,
  ) {
    const events = await readValidated(sessionId);
    for (const event of events ?? []) {
      if (event.seq >= fromSeq) yield event;
    }
  };

  const state: SessionStore["state"] = async (sessionId) => {
    const events = await readValidated(sessionId);
    if (!events) return undefined;
    try {
      return foldSessionState(events);
    } catch (error) {
      return await withSessionLock(
        sessionId,
        () => removeCorrupt(sessionId, pathFor(sessionId), error),
      );
    }
  };

  const listIds: SessionStore["listIds"] = async () => {
    try {
      const ids: string[] = [];
      for await (const entry of Deno.readDir(layout.sessions)) {
        if (!entry.isFile || !entry.name.endsWith(".jsonl")) continue;
        const id = entry.name.slice(0, -".jsonl".length);
        if (isSafeId(id)) ids.push(id);
      }
      return ids.sort();
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return [];
      throw error;
    }
  };

  const listRecent: SessionStore["listRecent"] = async (limit = 20) => {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error(
        `session list limit must be a positive integer: ${limit}`,
      );
    }
    const rows: Array<{ id: string; mtime: number }> = [];
    for (const id of await listIds()) {
      try {
        const stat = await Deno.stat(pathFor(id));
        rows.push({ id, mtime: stat.mtime?.getTime() ?? 0 });
      } catch (error) {
        // Retention can remove a Journal after filename enumeration.
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    rows.sort((a, b) => b.mtime - a.mtime || a.id.localeCompare(b.id));

    const states: SessionState[] = [];
    for (const row of rows.slice(0, limit)) {
      try {
        const value = await state(row.id);
        if (value) states.push(value);
      } catch (error) {
        if (!(error instanceof CorruptSessionError)) throw error;
      }
    }
    return states;
  };

  const lastSeq: SessionStore["lastSeq"] = async (sessionId) =>
    (await readValidated(sessionId))?.length ?? 0;

  const touch: SessionStore["touch"] = (sessionId) =>
    withSessionLock(sessionId, async () => {
      const path = pathFor(sessionId);
      const date = new Date(now());
      try {
        await Deno.utime(path, date, date);
        return true;
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
      }
    });

  const remove: SessionStore["remove"] = async (sessionId) => {
    await withSessionLock(sessionId, async () => {
      try {
        await Deno.remove(pathFor(sessionId));
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      seqBySession.delete(sessionId);
    });
  };

  const removeOlderThan: SessionStore["removeOlderThan"] = (
    sessionId,
    cutoffMs,
  ) =>
    withSessionLock(sessionId, async () => {
      const path = pathFor(sessionId);
      let stat: Deno.FileInfo;
      try {
        stat = await Deno.stat(path);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
      }
      const mtime = stat.mtime?.getTime();
      if (mtime === undefined || mtime > cutoffMs) return false;
      await Deno.remove(path);
      seqBySession.delete(sessionId);
      return true;
    });

  return {
    workspace: layout.workspace,
    sessionsDir: layout.sessions,
    append,
    replay,
    read: readValidated,
    state,
    listRecent,
    listIds,
    lastSeq,
    touch,
    remove,
    removeOlderThan,
    pathFor,
  };
};
