// Command execution helper for built-in tools.
//
// Deno.Command-based capture with per-stream output caps, timeout and
// AbortSignal → SIGKILL semantics. (When the sandbox/native layer lands, this
// is the seam where exec gets routed through the Rust side — for now there is
// no native dependency by design.)

export interface ExecOptions {
  /** Working directory. Inherited when omitted. */
  cwd?: string;
  /** Kill the child (SIGKILL) after this many ms. 0 / undefined = no timeout. */
  timeoutMs?: number;
  /** Merged on top of the parent environment. */
  env?: Record<string, string>;
  /** Bytes written to the child's stdin, then closed. */
  stdin?: string;
  /** Per-stream capture cap. Defaults to 1 MiB. Excess is discarded (see truncated). */
  maxOutputBytes?: number;
  /**
   * AbortSignal that, when aborted, SIGKILLs the child immediately. Lets the
   * scheduler cancel an in-flight subprocess without waiting for timeoutMs.
   */
  signal?: AbortSignal;
}

export interface ExecResult {
  /**
   * Process exit code. null when timed out (we SIGKILL) or killed by signal;
   * use `timedOut`/`aborted` to distinguish the cause from an external signal.
   */
  code: number | null;
  /** Decoded UTF-8 stdout (invalid sequences replaced with U+FFFD). */
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when an AbortSignal killed the child before natural exit. */
  aborted: boolean;
  truncated: boolean;
}

export const DEFAULT_MAX_OUTPUT_BYTES = 1 << 20; // 1 MiB per stream.

/**
 * Run a command, capturing stdout/stderr.
 *
 * cmd as a string is executed through the shell (/bin/sh -c on Unix,
 * cmd.exe /c on Windows). cmd as string[] is an argv vector (no shell).
 */
export async function execCapture(
  cmd: string | string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const isWindows = Deno.build.os === "windows";
  let exe: string;
  let args: string[];
  if (typeof cmd === "string") {
    if (isWindows) {
      exe = "cmd.exe";
      args = ["/d", "/s", "/c", cmd];
    } else {
      exe = "/bin/sh";
      args = ["-c", cmd];
    }
  } else {
    if (cmd.length === 0) throw new Error("tools/exec: cmd argv must be non-empty");
    [exe, ...args] = cmd;
  }

  const maxOut = opts.maxOutputBytes && opts.maxOutputBytes > 0
    ? Math.floor(opts.maxOutputBytes)
    : DEFAULT_MAX_OUTPUT_BYTES;

  const child = new Deno.Command(exe, {
    args,
    cwd: opts.cwd,
    env: opts.env ? { ...Deno.env.toObject(), ...opts.env } : undefined,
    stdin: opts.stdin != null ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  let timedOut = false;
  let aborted = false;
  let timer: number | undefined;

  const killChild = (cause: "timeout" | "abort") => {
    if (cause === "timeout") timedOut = true;
    else aborted = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
  };

  // Honour an AbortSignal by SIGKILLing the child immediately. The caller
  // (e.g. the scheduler via bash) can then synthesise an error result
  // instead of waiting for timeoutMs while the subprocess leaks.
  const onAbort = () => killChild("abort");
  if (opts.signal) {
    if (opts.signal.aborted) killChild("abort");
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(() => killChild("timeout"), opts.timeoutMs);
  }

  const readCapped = async (
    stream: ReadableStream<Uint8Array>,
  ): Promise<{ chunks: Uint8Array[]; truncated: boolean }> => {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total >= maxOut) continue; // drain remainder, discard
      const room = maxOut - total;
      if (value.length > room) {
        chunks.push(value.subarray(0, room));
        total = maxOut;
        truncated = true;
      } else {
        chunks.push(value);
        total += value.length;
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
    return { chunks, truncated };
  };

  const stdinP = (async () => {
    if (opts.stdin == null) return;
    const stdin = child.stdin;
    if (!stdin) return;
    const writer = stdin.getWriter();
    try {
      await writer.write(new TextEncoder().encode(opts.stdin));
      await writer.close();
    } catch {
      // child gone
    }
  })();

  const outP = readCapped(child.stdout);
  const errP = readCapped(child.stderr);
  await stdinP;
  const [out, err] = await Promise.all([outP, errP]);
  const status = await child.status;
  if (timer !== undefined) clearTimeout(timer);
  if (opts.signal) opts.signal.removeEventListener("abort", onAbort);

  return {
    // On timeout/abort we SIGKILL the child; the resulting status.code is
    // platform-dependent (137 on Unix). Normalize to null and let the
    // timedOut/aborted flags carry the reason — the real exit code is
    // meaningless.
    code: (timedOut || aborted) ? null : status.code,
    stdout: decode(out.chunks),
    stderr: decode(err.chunks),
    timedOut,
    aborted,
    truncated: out.truncated || err.truncated,
  };
}

function decode(chunks: Uint8Array[]): string {
  if (chunks.length === 0) return "";
  let len = 0;
  for (const c of chunks) len += c.length;
  const merged = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }
  return new TextDecoder().decode(merged);
}
