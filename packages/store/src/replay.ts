import { type RecordedEvent, parseEventLine } from "@niuma/schema";

// Scan a JSONL text blob into events. Tolerates a truncated LAST line (the
// typical crash signature: the file ends mid-write without a terminating
// newline). Throws on any other corrupt line.
export function replayText(text: string, filePath: string): RecordedEvent[] {
  if (text.length === 0) return [];
  const trailing = text.endsWith("\n");
  const raw = trailing ? text.slice(0, -1) : text;
  const lines = raw.split("\n");
  const out: RecordedEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!trailing && i === lines.length - 1) continue;
    const line = lines[i];
    if (line === "") continue;
    try {
      out.push(parseEventLine(line));
    } catch (err) {
      throw new Error(
        `Corrupt event log at ${filePath}:${i + 1}: ${(err as Error).message}`,
      );
    }
  }
  return out;
}

export function scanLastSeq(filePath: string): {
  seq: number;
  size: number;
  // Byte offset where good (parseable) data ends. If the file's last line
  // was truncated mid-write (no trailing "\n"), everything past this offset
  // is partial and the caller must truncate before re-opening for append.
  goodBytesEnd: number;
} {
  let stat: Deno.FileInfo;
  try {
    stat = Deno.statSync(filePath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return { seq: 0, size: 0, goodBytesEnd: 0 };
    }
    throw err;
  }
  if (stat.size === 0) return { seq: 0, size: 0, goodBytesEnd: 0 };
  const text = Deno.readTextFileSync(filePath);
  const events = replayText(text, filePath);
  let max = 0;
  for (const ev of events) if (ev.seq > max) max = ev.seq;
  // Mirror replayText's tolerance: a missing trailing "\n" means the final
  // line is a truncated write and must be discarded. Good data ends at the
  // byte boundary right after the last "\n" (or 0 if the file has none).
  const goodCharEnd = text.endsWith("\n")
    ? text.length
    : text.lastIndexOf("\n") + 1;
  const goodBytesEnd = goodCharEnd === 0
    ? 0
    : new TextEncoder().encode(text.slice(0, goodCharEnd)).byteLength;
  return { seq: max, size: stat.size, goodBytesEnd };
}
