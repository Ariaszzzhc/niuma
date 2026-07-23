// Argument parsing for the niuma CLI.
//
// Grammar:
//   niuma [options]                       interactive TUI (default; needs a TTY)
//   niuma tui [options]                   interactive TUI (explicit form)
//   niuma -p <prompt> [options]           one-shot mode
//   niuma serve [--port <port>] [--host]  TCP server mode
//   niuma --version | -V                  print version
//   niuma --help | -h                     print help
//
// The first positional token selects a subcommand: `serve` -> serve, `tui` ->
// interactive. Anything else is parsed as flags: with `-p/--prompt` it is a
// one-shot; without `-p` (and a TTY on stdin) it defaults to the interactive
// TUI. parseArgs from @std/cli handles the long/short flag aliases and `=`/
// space value forms.
//
// Pipe protection: a non-TTY stdin (e.g. `echo foo | niuma`) cannot host a
// fullscreen TUI, so both bare `niuma` and the explicit `niuma tui` form print
// help and exit 2 instead of trying to render into a pipe — the caller almost
// certainly forgot `-p`.

import { parseArgs } from "@std/cli";
import { resolve } from "@std/path";
import { VERSION } from "@niuma/config";

export type Subcommand = "oneshot" | "serve" | "interactive";

export interface OneShotArgs {
  readonly subcommand: "oneshot";
  readonly prompt: string;
  readonly workspace: string;
  /** Explicit --model override; undefined means "use config.toml's model". */
  readonly model?: string;
  /** Smoke-harness only: inject the scripted network-free provider into the
   * server worker (replaces the old NIUMA_MOCK_PROVIDER env switch). */
  readonly mockProvider: boolean;
}

export interface InteractiveArgs {
  readonly subcommand: "interactive";
  readonly workspace: string;
  /** Explicit --model override; undefined means "use config.toml's model". */
  readonly model?: string;
  /** Smoke-harness only: same flag as one-shot. */
  readonly mockProvider: boolean;
}

export interface ServeArgs {
  readonly subcommand: "serve";
  readonly port: number;
  readonly host: string;
}

export type ParsedArgs = OneShotArgs | ServeArgs | InteractiveArgs;

export type ParseResult =
  | { readonly ok: true; readonly args: ParsedArgs }
  // exitCode convention: 0 = success/help printed, 1 = every runtime/usage
  // failure. The single exception is exit 2, returned ONLY for the pipe-
  // protection case (bare `niuma` on a non-TTY stdin) — it lets wrappers tell
  // "refused to start" apart from a real error.
  | { readonly ok: false; readonly exitCode: number; readonly message?: string };

const DEFAULT_PORT = 4096;
const DEFAULT_HOST = "127.0.0.1";

export const parseCliArgs = (argv: string[]): ParseResult => {
  // Subcommand dispatch on the first non-flag positional. `serve` and `tui`
  // are the named subcommands; anything else is parsed as a flag sequence
  // (one-shot with -p, or default-to-interactive without).
  if (argv.length > 0 && argv[0] === "serve") {
    return parseServeArgs(argv.slice(1));
  }
  if (argv.length > 0 && argv[0] === "tui") {
    return parseInteractiveArgs(argv.slice(1));
  }

  const parsed = parseArgs(argv, {
    string: ["prompt", "workspace", "model"],
    boolean: ["version", "help", "mock-provider"],
    alias: {
      p: "prompt",
      h: "help",
      V: "version",
    },
    unknown: (name) => {
      // Reject anything that looks like an unknown flag. Bare positionals
      // are also unexpected in one-shot mode (the prompt comes via -p), so
      // treat a leading "-" as the signal for an unknown option.
      if (name.startsWith("-")) {
        console.error(`niuma: unknown option: ${name}`);
        console.error("Try `niuma --help` for usage.");
        Deno.exit(1);
      }
      // Allow stray positionals to pass through; they are ignored.
      return true;
    },
  });

  if (parsed.help) {
    printHelp();
    return { ok: false, exitCode: 0 };
  }
  if (parsed.version) {
    console.log(VERSION);
    return { ok: false, exitCode: 0 };
  }

  const prompt = parsed.prompt;
  if (!prompt || prompt.length === 0) {
    // No -p/--prompt -> interactive TUI. Refuse to launch the TUI when stdin
    // is not a TTY: `echo foo | niuma` would otherwise try to render a
    // fullscreen UI into a pipe. The user almost certainly forgot -p, so
    // point them at the help (exit 2 distinguishes this from a real fault).
    if (!Deno.stdin.isTerminal()) {
      printHelp();
      return { ok: false, exitCode: 2 };
    }
    return {
      ok: true,
      args: toInteractiveArgs(
        parsed.workspace,
        parsed.model,
        parsed["mock-provider"],
      ),
    };
  }

  const workspaceArg = parsed.workspace ?? Deno.cwd();
  const workspace = resolve(workspaceArg);
  // Model comes from --model or config.toml's top-level `model` key; there
  // is no env var. The resolved reference (which may come from the config)
  // is validated against the configured providers in main.ts.
  return {
    ok: true,
    args: {
      subcommand: "oneshot",
      prompt,
      workspace,
      mockProvider: parsed["mock-provider"] === true,
      ...(parsed.model !== undefined ? { model: parsed.model } : {}),
    },
  };
};

const parseInteractiveArgs = (argv: string[]): ParseResult => {
  const parsed = parseArgs(argv, {
    string: ["workspace", "model"],
    boolean: ["help", "mock-provider"],
    alias: { h: "help" },
    unknown: (name) => {
      if (name.startsWith("-")) {
        console.error(`niuma tui: unknown option: ${name}`);
        console.error("Try `niuma --help` for usage.");
        Deno.exit(1);
      }
      return true;
    },
  });

  if (parsed.help) {
    printHelp();
    return { ok: false, exitCode: 0 };
  }

  // `niuma tui` needs an interactive TTY on stdin exactly like bare `niuma`: a
  // fullscreen TUI cannot be driven from a pipe (e.g. `echo hi | niuma tui`),
  // so refuse early with the same help + exit-2 the bare form gives, rather
  // than failing deep inside the terminal layer where the cause is hidden.
  if (!Deno.stdin.isTerminal()) {
    printHelp();
    return { ok: false, exitCode: 2 };
  }

  return {
    ok: true,
    args: toInteractiveArgs(
      parsed.workspace,
      parsed.model,
      parsed["mock-provider"],
    ),
  };
};

const toInteractiveArgs = (
  workspace: string | undefined,
  model: string | undefined,
  mockProvider: boolean | undefined,
): InteractiveArgs => {
  const workspaceArg = workspace ?? Deno.cwd();
  return {
    subcommand: "interactive",
    workspace: resolve(workspaceArg),
    mockProvider: mockProvider === true,
    ...(model !== undefined ? { model } : {}),
  };
};

const parseServeArgs = (argv: string[]): ParseResult => {
  const parsed = parseArgs(argv, {
    string: ["port", "host"],
    boolean: ["help"],
    alias: { h: "help" },
    default: { port: String(DEFAULT_PORT), host: DEFAULT_HOST },
    unknown: (name) => {
      if (name.startsWith("-")) {
        console.error(`niuma serve: unknown option: ${name}`);
        console.error("Try `niuma serve --help` for usage.");
        Deno.exit(1);
      }
      return true;
    },
  });

  if (parsed.help) {
    printServeHelp();
    return { ok: false, exitCode: 0 };
  }

  const portNum = Number(parsed.port);
  if (
    !Number.isInteger(portNum) || portNum < 1 || portNum > 65535
  ) {
    console.error(`niuma serve: invalid port: ${parsed.port}`);
    return { ok: false, exitCode: 1 };
  }

  return {
    ok: true,
    args: {
      subcommand: "serve",
      port: portNum,
      host: parsed.host ?? DEFAULT_HOST,
    },
  };
};

export const printHelp = (): void => {
  const text = `niuma ${VERSION} — minimal server-first AI coding agent

USAGE
  niuma [options]                      Interactive TUI (default; needs a TTY).
  niuma tui [options]                  Interactive TUI (same as bare \`niuma\`).
  niuma -p <prompt> [options]          One-shot: run a prompt, print the answer.
  niuma serve [--port <port>]          Start a local HTTP + SSE server.
  niuma --version                      Print version and exit.
  niuma --help                         Show this help.

  With no -p/--prompt and a TTY on stdin, niuma launches the interactive TUI.
  If stdin is not a TTY (e.g. \`echo foo | niuma\`), it prints this help and
  exits 2 — pass -p to run one-shot over a pipe.

INTERACTIVE / TUI OPTIONS
      --workspace <path>              Workspace path (default: current dir).
      --model <provider/model-id>     Model to use (default: config.toml's "model").

ONE-SHOT OPTIONS
  -p, --prompt <text>                 Prompt text (required for one-shot).
      --workspace <path>              Workspace path (default: current dir).
      --model <provider/model-id>     Model to use (default: config.toml's "model").

SERVE OPTIONS
      --port <number>                 TCP port (default: 4096).
      --host <addr>                   Bind address (default: 127.0.0.1).

CONFIGURATION
  ~/.niuma/config.toml                 Providers, models, [core] options. Example:
                                        model = "deepseek/deepseek-chat"
                                        [core]
                                        log_level = "info"
                                        [provider.deepseek]
                                        base_url = "https://api.deepseek.com/v1"
                                        [provider.deepseek.models.deepseek-chat]
                                        context_window = 128000
                                        max_output = 8192
  ~/.niuma/auth.json                   API credentials keyed by provider id (0600):
                                        { "deepseek": { "type": "api", "key": "sk-..." } }
  ~/.niuma/log/                        Per-process JSON-lines logs.
  ./.niuma/config.toml                 Project-level config, discovered walking up
                                      from the workspace to $HOME (every dir's
                                      .niuma/config.toml loads, closest wins).
                                      Merged over the global file — e.g. pin a
                                      project model: model = "deepseek/deepseek-chat"

ENVIRONMENT (path overrides only — no provider configuration)
  NIUMA_DATA_DIR                       Override data dir (also relocates config).
  NIUMA_CONFIG                         Path to an explicit config.toml.
  NIUMA_WORKSPACE                      Default workspace path.

During a one-shot run, tool calls that the permission policy cannot auto-resolve
trigger an interactive prompt on stdin:
  y = allow once    a = always (synthesize a rule)    n = reject
`;
  console.log(text);
};

export const printServeHelp = (): void => {
  const text = `niuma ${VERSION} serve — local HTTP + SSE server

USAGE
  niuma serve [--port <port>] [--host <addr>]

OPTIONS
      --port <number>     TCP port (default: 4096).
      --host <addr>       Bind address (default: 127.0.0.1).
  -h, --help              Show this help.

The server exposes the REST + SSE API on the bound address. See \`niuma --help\`
for configuration (config.toml + auth.json).
`;
  console.log(text);
};
