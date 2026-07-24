// Shared stdin line reader (TTY- and pipe-friendly, byte-wise).
//
// Used by the one-shot permission prompt (run.ts) and the auth command's
// method/key prompts (auth_cmd.ts). Centralised here so auth_cmd does not
// have to import the whole one-shot runner just to read a line.
//
// Byte-wise read keeps the rest of stdin's buffer intact. Deno.stdin.read
// returns at most N bytes per call, so a 1-byte request drains exactly one
// byte at a time. We stop at newline (cooked-mode TTY submits on Enter) or
// EOF (Ctrl+D / closed pipe).

export const readStdinLine = async (): Promise<string | null> => {
  const decoder = new TextDecoder();
  const buf = new Uint8Array(1);
  let line = "";

  while (true) {
    let n: number | null;
    try {
      n = await Deno.stdin.read(buf);
    } catch {
      return line.length > 0 ? line : null;
    }
    if (n === null || n === 0) {
      return line.length > 0 ? line : null;
    }
    const ch = decoder.decode(buf.subarray(0, n));
    if (ch === "\n") {
      return line.endsWith("\r") ? line.slice(0, -1) : line;
    }
    if (ch === "\r") {
      // Swallow; wait for \n.
      continue;
    }
    // Ignore other control bytes (e.g. the user's Ctrl+D is signalled by
    // EOF via n === 0, not by a control char).
    if (ch >= " ") {
      line += ch;
      // Safety cap so a runaway stdin cannot OOM us.
      if (line.length > 4096) {
        return line;
      }
    }
  }
};

/** Read a line from stdin with echo suppressed (raw mode), for credential
 * entry — keeps a pasted API key out of terminal scrollback / tmux history /
 * screen shares. Falls back to the echoed {@link readStdinLine} when stdin is
 * not a TTY so piped input still works. The terminal is restored to cooked
 * mode in a `finally` so a Ctrl+C mid-read never leaves it raw. */
export const readSecretLine = async (): Promise<string | null> => {
  if (!Deno.stdin.isTerminal()) {
    return readStdinLine();
  }
  const decoder = new TextDecoder();
  let line = "";
  // Raw mode: no echo, no line buffering, control keys delivered as bytes.
  Deno.stdin.setRaw(true);
  const buf = new Uint8Array(1);
  try {
    while (true) {
      let n: number | null;
      try {
        n = await Deno.stdin.read(buf);
      } catch {
        return line.length > 0 ? line : null;
      }
      if (n === null || n === 0) {
        return line.length > 0 ? line : null;
      }
      const code = buf[0]!;
      // Ctrl+C (0x03) / Ctrl+D (0x04): abort the prompt like a cancellation.
      if (code === 0x03 || code === 0x04) return null;
      // Enter (\r or \n): the terminal is in raw mode so it does not echo the
      // newline — emit one so the next prompt starts on a fresh line.
      if (code === 0x0d || code === 0x0a) {
        await Deno.stderr.write(new TextEncoder().encode("\n"));
        return line;
      }
      // Backspace (0x7f) / ^H (0x08): drop the last typed char.
      if (code === 0x7f || code === 0x08) {
        if (line.length > 0) line = line.slice(0, -1);
        continue;
      }
      const ch = decoder.decode(buf.subarray(0, n));
      if (ch >= " ") {
        line += ch;
        if (line.length > 4096) return line;
      }
    }
  } finally {
    try {
      Deno.stdin.setRaw(false);
    } catch {
      // already restored / never set
    }
  }
};
