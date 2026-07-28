// Argument parsing for the niuma CLI.
//
// Grammar:
//   niuma [options]                       interactive TUI (default; needs a TTY)
//   niuma tui [options]                   interactive TUI (explicit form)
//   niuma -p <prompt> [options]           one-shot mode
//   niuma serve [--port <port>] [--host]  TCP server mode
//   niuma auth login|logout|status [...]  credential management
//   niuma --version | -V                  print version
//   niuma --help | -h                     print help
//
// The first positional token selects a subcommand: `serve`, `tui`, or `auth`
// are the named subcommands; anything else is parsed as flags: with
// `-p/--prompt` it is a one-shot; without `-p` (and a TTY on stdin) it
// defaults to the interactive TUI. parseArgs from @std/cli handles the
// long/short flag aliases and `=`/space value forms.
//
// Pipe protection: a non-TTY stdin (e.g. `echo foo | niuma`) cannot host a
// fullscreen TUI, so both bare `niuma` and the explicit `niuma tui` form print
// help and exit 2 instead of trying to render into a pipe — the caller almost
// certainly forgot `-p`.

import { parseArgs } from "@std/cli";
import { resolve } from "@std/path";
import { VERSION } from "@niuma/config";

export type Subcommand = "oneshot" | "serve" | "interactive" | "auth";

export interface OneShotArgs {
  readonly subcommand: "oneshot";
  readonly prompt: string;
  readonly workspace: string;
  /** Explicit --model override; undefined means "use config.toml's model". */
  readonly model?: string;
  /** Automatically approve every permission request in one-shot mode.
   * Intended for isolated benchmark/sandbox environments only. */
  readonly bypassPermissions: boolean;
  /** Smoke-harness only: inject the scripted network-free provider into the
   * server worker. */
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

/** `niuma auth` — credential management over ~/.niuma/auth.json.
 *
 * action: "login" obtains credentials; "logout" drops them; "status" prints
 *   the entry's type (+ expiry for OAuth), never the token material. "list"
 *   is accepted at the CLI as an alias for "status".
 * providerId: positional; UNDEFINED when the user passes none. For login that
 *   means "show the provider picker" (kimi / openai / anthropic / custom,
 *   with a method sub-menu where a provider offers several); for
 *   logout/status the command falls back to "openai". Built-in providers
 *   ("kimi", "openai") need no config.toml table — login-and-go; "kimi"
 *   offers its device-code flow or a pasted API key, "anthropic" always
 *   takes a pasted API key. Any other id is accepted: the ChatGPT
 *   OAuth flow is provider-id-agnostic, so the resulting entry is stored
 *   under whatever id is passed (e.g. "chatgpt"), paired with a
 *   type="responses" provider table.
 * deviceCode: --device-code selects the headless device-code flow, skipping
 *   the interactive method picker (a no-op for anthropic — API key only). */
export interface AuthArgs {
  readonly subcommand: "auth";
  readonly action: "login" | "logout" | "status";
  readonly providerId?: string;
  readonly deviceCode: boolean;
}

export type ParsedArgs =
  | OneShotArgs
  | ServeArgs
  | InteractiveArgs
  | AuthArgs;

export type ParseResult =
  | { readonly ok: true; readonly args: ParsedArgs }
  // exitCode convention: 0 = success/help printed, 1 = every runtime/usage
  // failure. The single exception is exit 2, returned ONLY for the pipe-
  // protection case (bare `niuma` on a non-TTY stdin) — it lets wrappers tell
  // "refused to start" apart from a real error.
  | {
    readonly ok: false;
    readonly exitCode: number;
    readonly message?: string;
  };

const DEFAULT_PORT = 4096;
const DEFAULT_HOST = "127.0.0.1";

export const parseCliArgs = (argv: string[]): ParseResult => {
  // Subcommand dispatch on the first non-flag positional. `serve`, `tui`, and
  // `auth` are the named subcommands; anything else is parsed as a flag
  // sequence (one-shot with -p, or default-to-interactive without).
  if (argv.length > 0 && argv[0] === "serve") {
    return parseServeArgs(argv.slice(1));
  }
  if (argv.length > 0 && argv[0] === "tui") {
    return parseInteractiveArgs(argv.slice(1));
  }
  if (argv.length > 0 && argv[0] === "auth") {
    return parseAuthArgs(argv.slice(1));
  }

  const parsed = parseArgs(argv, {
    string: ["prompt", "workspace", "model"],
    boolean: [
      "version",
      "help",
      "mock-provider",
      "dangerously-bypass-permissions",
    ],
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
      bypassPermissions: parsed["dangerously-bypass-permissions"] === true,
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

const parseAuthArgs = (argv: string[]): ParseResult => {
  const parsed = parseArgs(argv, {
    boolean: ["help", "device-code"],
    alias: { h: "help" },
    unknown: (name) => {
      if (name.startsWith("-")) {
        console.error(`niuma auth: unknown option: ${name}`);
        console.error("Try `niuma auth --help` for usage.");
        Deno.exit(1);
      }
      return true;
    },
  });

  if (parsed.help) {
    printAuthHelp();
    return { ok: false, exitCode: 0 };
  }

  // positionals: [action, provider?]. `list` is accepted as an alias for
  // `status` (the binding contract's action name).
  const positionals = parsed._.map(String);
  const actionRaw = positionals[0];

  let action: AuthArgs["action"];
  switch (actionRaw) {
    case "login":
      action = "login";
      break;
    case "logout":
      action = "logout";
      break;
    case "status":
    case "list":
      action = "status";
      break;
    case undefined:
      // Bare `niuma auth` — print usage, like `niuma --help`.
      printAuthHelp();
      return { ok: false, exitCode: 0 };
    default:
      console.error(`niuma auth: unknown action '${actionRaw}'.`);
      console.error("Try `niuma auth --help` for usage.");
      return { ok: false, exitCode: 1 };
  }

  // providerId stays undefined when omitted: login shows the provider
  // picker; logout/status fall back to "openai" (see auth_cmd.ts).
  const providerId = positionals[1];
  return {
    ok: true,
    args: {
      subcommand: "auth",
      action,
      ...(providerId !== undefined ? { providerId } : {}),
      deviceCode: parsed["device-code"] === true,
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
  niuma auth login|logout|status       Manage credentials (see \`niuma auth --help\`).
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
      --dangerously-bypass-permissions
                                      Auto-approve permission requests. Use only
                                      inside an isolated benchmark/sandbox.

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
                                      For the ChatGPT Responses flavour (use with
                                      \`niuma auth login openai\`):
                                        [provider.openai]
                                        type = "responses"
                                        [provider.openai.models.gpt-5]
                                        context_window = 400000
                                        max_output = 128000
  ~/.niuma/auth.json                   API credentials keyed by provider id (0600):
                                        { "deepseek": { "type": "api", "key": "sk-..." } }
                                      \`niuma auth login openai\` writes a ChatGPT OAuth entry:
                                        { "openai": { "type": "oauth", "refresh": "...",
                                                      "access": "...", "expires": 1730000000000 } }
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

export const printAuthHelp = (): void => {
  const text = `niuma ${VERSION} auth — manage credentials in ~/.niuma/auth.json

USAGE
  niuma auth login [provider] [--device-code]
  niuma auth logout [provider]
  niuma auth status [provider]            (\`list\` is accepted as an alias)
  niuma auth --help

ACTIONS
  login   Obtain credentials for a provider. Without a provider argument it
          asks which service to sign in to:
            1. Kimi                    second-level method picker:
                 a. Kimi subscription (device code).
                 b. Manually enter API Key.
            2. OpenAI / ChatGPT        second-level method picker:
                 a. ChatGPT Pro/Plus (browser)      PKCE + loopback on :1455.
                 b. ChatGPT Pro/Plus (device code)  for headless machines.
                 c. Manually enter API Key          paste an sk-… key.
            3. Anthropic               paste an API key.
            4. Custom provider         prompts for the id, then the OpenAI
                                       method picker above.
          \`niuma auth login <id>\` skips the first-level picker and goes
          straight to that provider's flow. --device-code skips the method
          picker and runs the headless device flow (the default for kimi on
          a non-TTY stdin). niuma never opens a browser for you: it prints
          the URL to visit.
  logout  Drop the provider's entry from auth.json (default: openai).
  status  Print the provider's credential type (+ expiry for OAuth).
          Never prints token material (default: openai).

NOTES
  Built-in providers (kimi, openai) are login-and-go — no config.toml
  changes needed; a same-named [provider.<id>] table overlays the built-in
  (user fields win). The kimi credential kind picks the endpoint: OAuth →
  the Kimi Code subscription (api.kimi.com/coding/v1); API key → the Kimi
  open platform (api.moonshot.cn/v1). Any other id is accepted for login:
  the ChatGPT OAuth flow is provider-id-agnostic and stores the entry under
  the given id (e.g. 'chatgpt'), which must then be paired with a
  type="responses" provider table in config.toml. Credentials are stored in
  auth.json (mode 0600), e.g.
    { "openai": { "type": "oauth", "refresh": "...",
                  "access": "...", "expires": 1730000000000 } }
`;
  console.log(text);
};
