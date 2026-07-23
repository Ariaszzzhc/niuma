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
  /** Explicit --model override; undefined means "use config.toml's model". */
  readonly model?: string;
  /** Smoke-harness only: inject the scripted network-free provider into the
   * server worker (replaces the old NIUMA_MOCK_PROVIDER env switch). */
  readonly mockProvider: boolean;
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

export const parseCliArgs = (argv: string[]): ParseResult => {
  // Subcommand dispatch on the first non-flag positional. `serve` is the only
  // subcommand; anything else is treated as a one-shot flag sequence.
  if (argv.length > 0 && argv[0] === "serve") {
    return parseServeArgs(argv.slice(1));
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
      --model <provider/model-id>     Model to use (default: config.toml's "model").

SERVE OPTIONS
      --port <number>                 TCP port (default: 4096).
      --host <addr>                   Bind address (default: 127.0.0.1).

CONFIGURATION
  ~/.config/niuma/config.toml          Providers, models, [core] options. Example:
                                        model = "deepseek/deepseek-chat"
                                        [core]
                                        log_level = "info"
                                        [provider.deepseek]
                                        base_url = "https://api.deepseek.com/v1"
                                        [provider.deepseek.models.deepseek-chat]
                                        context_window = 128000
                                        max_output = 8192
  ~/.local/share/niuma/auth.json       API credentials keyed by provider id (0600):
                                        { "deepseek": { "type": "api", "key": "sk-..." } }
  ~/.local/share/niuma/log/            Per-process JSON-lines logs.
  ./niuma.toml                         Project-level config, discovered walking up
                                      from the workspace to $HOME. Merged over the
                                      global file (closest directory wins) — e.g.
                                      pin a project model: model = "deepseek/deepseek-chat"

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
  const text = `niuma ${CLI_VERSION} serve — local HTTP + SSE server

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
