import {
  type RecordedEvent,
  type SessionCreatedData,
  stringifyEventLine,
} from "@niuma/schema";
import { join } from "@std/path";
import {
  DEFAULT_DATA_DIR,
  ensureDataDirSync,
  pathExistsSync,
} from "./paths.ts";
import { replayText, scanLastSeq } from "./replay.ts";

export type NewEvent = Omit<RecordedEvent, "seq">;

export class EventLog {
  readonly sessionId: string;
  readonly filePath: string;

  #file: Deno.FsFile | null = null;
  #lastSeq: number;
  #size: number;

  private constructor(
    sessionId: string,
    filePath: string,
    file: Deno.FsFile,
    lastSeq: number,
    size: number,
  ) {
    this.sessionId = sessionId;
    this.filePath = filePath;
    this.#file = file;
    this.#lastSeq = lastSeq;
    this.#size = size;
  }

  get lastSeq(): number {
    return this.#lastSeq;
  }

  get size(): number {
    return this.#size;
  }

  static open(
    sessionId: string,
    dataDir: string = DEFAULT_DATA_DIR,
  ): EventLog {
    ensureDataDirSync(dataDir);
    const filePath = join(dataDir, "sessions", `${sessionId}.jsonl`);
    const { seq, size, goodBytesEnd } = scanLastSeq(filePath);
    // If the file ends with a partially-written line (crash signature:
    // missing trailing "\n"), truncate the partial bytes away BEFORE
    // re-opening for append — otherwise the next appended line glues onto
    // the partial and permanently corrupts the JSONL log.
    let initSize = size;
    if (size > goodBytesEnd) {
      Deno.truncateSync(filePath, goodBytesEnd);
      initSize = goodBytesEnd;
    }
    const file = Deno.openSync(filePath, {
      create: true,
      append: true,
      read: false,
    });
    return new EventLog(sessionId, filePath, file, seq, initSize);
  }

  static create(
    sessionId: string,
    data: SessionCreatedData,
    dataDir: string = DEFAULT_DATA_DIR,
  ): EventLog {
    ensureDataDirSync(dataDir);
    const filePath = join(dataDir, "sessions", `${sessionId}.jsonl`);
    const fresh = !pathExistsSync(filePath);
    const log = EventLog.open(sessionId, dataDir);
    if (fresh) {
      log.append({
        ts: Date.now(),
        sessionId,
        type: "session.created",
        data,
      });
      log.flush();
    }
    return log;
  }

  append(event: NewEvent): RecordedEvent {
    if (this.#file === null) throw new Error("EventLog: append after close");
    const full = { ...event, seq: ++this.#lastSeq } as RecordedEvent;
    const line = stringifyEventLine(full) + "\n";
    const bytes = new TextEncoder().encode(line);
    // writeSync guarantees the bytes land in the kernel page cache before the
    // subsequent flush()/sync() — a floating write() Promise is not durable.
    this.#file.writeSync(bytes);
    this.#size += bytes.byteLength;
    return full;
  }

  flush(): void {
    if (this.#file === null) return;
    // syncSync is the synchronous fsync — sync() returns a Promise that would
    // race the next append() and trip Deno's leak detector, defeating the
    // "flush before returning" contract.
    this.#file.syncSync();
  }

  close(): void {
    if (this.#file === null) return;
    this.#file.close();
    this.#file = null;
  }

  static async *replay(
    sessionId: string,
    dataDir: string = DEFAULT_DATA_DIR,
  ): AsyncGenerator<RecordedEvent, void, void> {
    const filePath = join(dataDir, "sessions", `${sessionId}.jsonl`);
    let text: string;
    try {
      text = await Deno.readTextFile(filePath);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return;
      throw err;
    }
    const events = replayText(text, filePath);
    for (const ev of events) yield ev;
  }

  static listSessionFiles(
    dataDir: string = DEFAULT_DATA_DIR,
  ): string[] {
    const dir = join(dataDir, "sessions");
    ensureDataDirSync(dataDir);
    const out: string[] = [];
    for (const entry of Deno.readDirSync(dir)) {
      if (entry.isFile && entry.name.endsWith(".jsonl")) {
        out.push(entry.name.slice(0, -".jsonl".length));
      }
    }
    out.sort();
    return out;
  }
}
