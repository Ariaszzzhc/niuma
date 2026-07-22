// Argument parsing for the niuma CLI.
//
// Grammar:
//   niuma -p <prompt> [--workspace <path>] [--model <name>]   one-shot mode
//   niuma serve [--port <port>] [--host <host>]                TCP server mode
//   niuma --version | -V                                       print version
//   niuma --help | -h                                          print help
//
// The first positional token (if it is `serve`) selects the serve subcommand.
// Anything else is parsed as one-shot flags. parseArgs from @std/cli handles
// the long/short flag aliases and `=`/space value forms.

import { parseArgs } from "@std/cli";
import { resolve } from "@std/path";
import { CLI_VERSION } from "./version.ts";

export type Subcommand = "oneshot" | "serve";

export interface OneShotArgs {
  readonly subcommand: "oneshot";
  readonly prompt: string;
  readonly workspace: string;
  readonly model: string;
}

export interface ServeArgs {
  readonly subcommand: "serve";
  readonly port: number;
  readonly host: string;
}

export type ParsedArgs = OneShotArgs | ServeArgs;

export type ParseResult =
  | { readonly ok: true; readonly args: ParsedArgs }
  | { readonly ok: false; readonly exitCode: number; readonly message?: string };

const DEFAULT_PORT = 4096;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_MODEL = "gpt-5-mini";

export const parseCliArgs = (argv: string[]): ParseResult => {
  // Subcommand dispatch on the first non-flag positional. `serve` is the only
  // subcommand; anything else is treated as a one-shot flag sequence.
  if (argv.length > 0 && argv[0] === "serve") {
    return parseServeArgs(argv.slice(1));
  }

  const parsed = parseArgs(argv, {
    string: ["prompt", "workspace", "model"],
    boolean: ["version", "help"],
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
        Deno.exit(2);
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
    console.log(CLI_VERSION);
    return { ok: false, exitCode: 0 };
  }

  const prompt = parsed.prompt;
  if (!prompt || prompt.length === 0) {
    console.error("niuma: missing required option -p/--prompt <text>");
    console.error("Try `niuma --help` for usage.");
    return { ok: false, exitCode: 2 };
  }

  const workspaceArg = parsed.workspace ?? Deno.cwd();
  const workspace = resolve(workspaceArg);
  // Effective model: --model flag wins, else NIUMA_MODEL env, else the same
  // default the provider adapter uses (keeps CLI/server consistent without
  // requiring the user to export NIUMA_MODEL).
  const model = parsed.model ??
    Deno.env.get("NIUMA_MODEL") ??
    DEFAULT_MODEL;

  return {
    ok: true,
    args: { subcommand: "oneshot", prompt, workspace, model },
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
        Deno.exit(2);
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
    return { ok: false, exitCode: 2 };
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
  const text = `niuma ${CLI_VERSION} — minimal server-first AI coding agent

USAGE
  niuma -p <prompt> [options]          One-shot: run a prompt, print the answer.
  niuma serve [--port <port>]          Start a local HTTP + SSE server.
  niuma --version                      Print version and exit.
  niuma --help                         Show this help.

ONE-SHOT OPTIONS
  -p, --prompt <text>                 Prompt text (required).
      --workspace <path>              Workspace path (default: current dir).
      --model <name>                  Model name (default: $NIUMA_MODEL or gpt-5-mini).

SERVE OPTIONS
      --port <number>                 TCP port (default: 4096).
      --host <addr>                   Bind address (default: 127.0.0.1).

ENVIRONMENT
  NIUMA_BASE_URL                       OpenAI-compatible base URL.
  NIUMA_API_KEY                        Provider API key.
  NIUMA_MODEL                          Default model name.
  NIUMA_WORKSPACE                      Default workspace path.
  NIUMA_DATA_DIR                       User data dir (default: ~/.config/niuma).
  NIUMA_LOG                            Log level: trace|debug|info|warning|error|fatal.

During a one-shot run, tool calls that the permission policy cannot auto-resolve
trigger an interactive prompt on stdin:
  y = allow once    a = always (synthesize a rule)    n = reject
`;
  console.log(text);
};

export const printServeHelp = (): void => {
  const text = `niuma ${CLI_VERSION} serve — local HTTP + SSE server

USAGE
  niuma serve [--port <port>] [--host <addr>]

OPTIONS
      --port <number>     TCP port (default: 4096).
      --host <addr>       Bind address (default: 127.0.0.1).
  -h, --help              Show this help.

The server exposes the REST + SSE API on the bound address. See \`niuma --help\`
for environment variables.
`;
  console.log(text);
};
