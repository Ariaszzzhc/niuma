// Logging setup for niuma.
//
// Level comes from `[core] log_level` in config.toml (default "info") — no
// environment variable. Two sinks:
//   - a console/stream sink chosen by the caller (stderr for the one-shot
//     worker where stdout is reserved for the final answer, stdout for the
//     long-running `niuma serve` process)
//   - a JSON-lines file under <data>/log/ (opencode's convention: XDG data
//     dir + app name + "log"), so post-mortems don't depend on the terminal
//     still being around.

import {
  configure,
  getConsoleSink,
  getLogger,
  getStreamSink,
  type Sink,
} from "@logtape/logtape";
import { loadConfigFile, niumaPaths, type LogLevel } from "@niuma/config";
import { join } from "@std/path";

let configured = false;

const CATEGORIES: ReadonlyArray<string | readonly string[]> = [
  ["niuma"],
  "niuma.server",
  "niuma.server.http",
  "niuma.server.kernel",
  "niuma.server.projection",
];

export interface LoggerOptions {
  /** Console sink: "stdout" (serve) or "stderr" (one-shot worker). */
  readonly console?: "stdout" | "stderr";
  /** Skip the file sink (tests). Default: write to <data>/log/. */
  readonly file?: boolean;
}

// A sink that appends rendered records to a per-process log file. Lines are
// JSON so post-processing (jq) stays trivial.
const makeFileSink = (filePath: string): Sink => {
  let fd: Deno.FsFile | null = null;
  const encoder = new TextEncoder();
  return (record) => {
    try {
      fd ??= Deno.openSync(filePath, {
        write: true,
        create: true,
        append: true,
      });
      const line = JSON.stringify({
        ts: record.timestamp,
        level: record.level,
        category: record.category.join("."),
        message: record.message.join(""),
      }) + "\n";
      fd.writeSync(encoder.encode(line));
    } catch {
      // Logging must never take the process down — drop the record.
    }
  };
};

export const setupLogger = async (
  opts: LoggerOptions = {},
): Promise<void> => {
  if (configured) return;
  configured = true;

  let level: LogLevel = "info";
  try {
    level = (await loadConfigFile(niumaPaths().configFile)).core.logLevel;
  } catch {
    // Unreadable/invalid config must not prevent startup logging.
  }

  const sinks: Record<string, Sink> = {};
  const activeSinks: string[] = [];

  if (opts.console !== undefined) {
    sinks.console = opts.console === "stderr"
      ? getStreamSink(Deno.stderr.writable)
      : getConsoleSink();
    activeSinks.push("console");
  }

  if (opts.file !== false) {
    try {
      const { log: logDir } = niumaPaths();
      await Deno.mkdir(logDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      sinks.file = makeFileSink(join(logDir, `${stamp}-${Deno.pid}.log`));
      activeSinks.push("file");
    } catch {
      // No writable log dir — console-only it is.
    }
  }

  if (activeSinks.length === 0) return;

  await configure({
    sinks,
    filters: {},
    loggers: CATEGORIES.map((category) => ({
      category: category as string,
      lowestLevel: level,
      sinks: activeSinks,
    })),
  });
};

export const log = (category: string = "niuma.server") => getLogger(category);
