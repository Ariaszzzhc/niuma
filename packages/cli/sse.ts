// Minimal SSE frame parser.
//
// The server's `/events` endpoint emits standard Server-Sent Events frames:
//
//   id: <cursor>
//   event: <type>
//   data: <json>
//
//   <blank line>
//
// Frames are separated by a blank line. Multi-line `data:` fields are joined
// with "\n" per the SSE spec. Comment lines (starting with ":") and unknown
// fields are ignored. The parser yields one { id, event, data } per frame.

export interface SseFrame {
  readonly id?: string;
  readonly event?: string;
  readonly data: string;
}

/**
 * Parse a ReadableStream of bytes (UTF-8 text) into an async iterator of
 * complete SSE frames. Returns when the underlying stream is exhausted or
 * errors.
 */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let id: string | undefined;
  let event: string | undefined;
  const dataLines: string[] = [];

  const flush = function* (): Generator<SseFrame> {
    // A frame is "complete" when we see a blank line; only then do we emit.
    if (id !== undefined || event !== undefined || dataLines.length > 0) {
      yield {
        ...(id !== undefined ? { id } : {}),
        ...(event !== undefined ? { event } : {}),
        data: dataLines.join("\n"),
      };
    }
    id = undefined;
    event = undefined;
    dataLines.length = 0;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Process complete lines; keep the trailing partial in buffer.
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const rawLine = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        // Normalise CRLF -> strip a trailing CR.
        const line = rawLine.endsWith("\r")
          ? rawLine.slice(0, -1)
          : rawLine;

        if (line === "") {
          // Frame boundary.
          for (const frame of flush()) yield frame;
          continue;
        }
        if (line.startsWith(":")) {
          // Comment line (heartbeat uses `: ping` sometimes — ignored).
          continue;
        }
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        // Per spec, a leading space after the colon is stripped.
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);

        if (field === "data") {
          dataLines.push(value);
        } else if (field === "event") {
          event = value;
        } else if (field === "id") {
          id = value;
        }
        // Other fields (retry, etc.) are ignored.
      }
    }

    // Flush any trailing bytes as a final line — needed if the server closes
    // the stream without a trailing blank line.
    buffer += decoder.decode();
    if (buffer.length > 0) {
      const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      buffer = "";
      if (line === "") {
        for (const frame of flush()) yield frame;
      } else if (!line.startsWith(":")) {
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "data") {
          dataLines.push(value);
        } else if (field === "event") {
          event = value;
        } else if (field === "id") {
          id = value;
        }
      }
    }
    // Final flush for any unterminated frame.
    for (const frame of flush()) yield frame;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released.
    }
  }
}
