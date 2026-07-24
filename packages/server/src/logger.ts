// Logging setup for niuma.
//
// Level comes from `[core] log_level` in the GLOBAL config.toml (default
// "info") — no environment variable. Project-level .niuma/config.toml files
// are NOT consulted here: logging is per-process (one log file per PID), while
// the
// server can host sessions from many workspaces, so a per-project log level
// has no coherent meaning.
//
// The ONLY sink is a JSON-lines file under <data>/log/ (~/.niuma/log by
// default). There is deliberately no
// console/stream sink: the server runs either inside a worker thread
// (interactive / one-shot CLI), where worker stdio is the parent's terminal
// — the TUI owns the alternate screen and any stray write corrupts the
// frame — or as a plain daemon (`niuma serve`), where nobody is watching the
// terminal and the file is the durable record either way.

import { configure, getLogger, type Sink } from "@logtape/logtape";
import { niumaPaths, loadConfigFile, type LogLevel } from "@niuma/config";
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
    level = (await loadConfigFile(niumaPaths().configFile)).core.logLevel ??
      "info";
  } catch {
    // Unreadable/invalid config must not prevent startup logging.
  }

  if (opts.file === false) return;

  try {
    const { log: logDir } = niumaPaths();
    await Deno.mkdir(logDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const sinks = { file: makeFileSink(join(logDir, `${stamp}-${Deno.pid}.log`)) };
    await configure({
      sinks,
      filters: {},
      loggers: CATEGORIES.map((category) => ({
        category: category as string,
        lowestLevel: level,
        sinks: ["file"],
      })),
    });
  } catch {
    // No writable log dir — run without logging rather than crash.
  }
};

export const log = (
  category: string = "niuma.server",
): ReturnType<typeof getLogger> => getLogger(category);
