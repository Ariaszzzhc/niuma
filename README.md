# Niuma Agent

[English](README.md) | [简体中文](README.zh-CN.md)

Niuma Agent is an AI coding agent that runs in your terminal. It can read and
edit code, run shell commands, search files, and plan and adjust its next step
based on the feedback it receives. Everything drives a single event-sourced
core: each session is an append-only JSONL journal on disk, with no database to
run or migrate.

_The name: niúmǎ (牛马) is Chinese internet slang for the tireless beast of
burden that does all the work. This one works for you._

One binary, three interfaces on the same core: a fullscreen interactive TUI, a
one-shot prompt mode, and an HTTP+SSE server.

niuma is written in TypeScript on [Deno](https://deno.com), with a small Rust
library for the TUI hot paths.

## Status

Early development. v0.1.0 is the first tagged release. Behavior and interfaces
may change between releases without migration paths.

## Install

Prebuilt binaries for Linux (x86_64), macOS (Apple Silicon), and Windows
(x86_64).

Linux / macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/Ariaszzzhc/niuma/main/scripts/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/Ariaszzzhc/niuma/main/scripts/install.ps1 | iex
```

The installer downloads the matching archive from
[GitHub Releases](https://github.com/Ariaszzzhc/niuma/releases), verifies it
against the release's `SHA256SUMS`, and installs to `~/.niuma/bin`. Set
`NIUMA_INSTALL` to change the install root, or pass a version argument (or
`NIUMA_VERSION`) to pin a release. You can also download an archive from the
releases page directly.

### Build from source

Requires Deno 2.x and a Rust toolchain:

```sh
git clone https://github.com/Ariaszzzhc/niuma.git
cd niuma
deno task build   # native library + deno compile -> dist/niuma
```

## Quick start

```sh
niuma auth login kimi     # OAuth device flow; or: niuma auth login openai
cd your-project
niuma                     # interactive TUI
```

One-shot mode, for scripts and quick questions:

```sh
niuma -p "explain the main modules of this repo"
```

Configuration lives in `~/.niuma/config.toml`, with per-project overrides in
`<project>/.niuma/config.toml`. Models are referenced as `provider/model-id`,
via `--model` or the top-level `model` key in `config.toml`.

## Features

- **Interactive TUI.** Streaming transcript, markdown rendering, inline
  approvals, and slash-command completion.
- **Built-in tools.** Bash, file read/write/edit, glob, grep, patch, subagents,
  and plan tracking.
- **Login and go.** OAuth device flow for Kimi and ChatGPT accounts, or paste an
  API key. Custom OpenAI/Anthropic-compatible providers are declared as
  `[provider.*]` tables in `config.toml`.
- **Resumable sessions.** `/resume` continues a previous session; `/compact`
  folds history when the context fills up.
- **Agent skills.** Drop a `SKILL.md` into `~/.niuma/skills/` or
  `.niuma/skills/` and the model loads it on demand; you can also invoke it
  directly as `/name args`.
- **Custom slash commands.** Markdown prompt templates in `~/.niuma/commands/`
  or `.niuma/commands/`, with `$ARGUMENTS` / `$1..$N` placeholders.
- **MCP support.** Servers configured in `mcp.json` appear as niuma tools.
- **HTTP+SSE server.** `niuma serve` exposes the same agent core for custom
  clients and debugging.

## Development

```sh
deno task check   # type-check
deno task test    # full test suite (network-free)
deno task cli     # run the CLI from source
```

See [AGENTS.md](AGENTS.md) for the architecture overview, package map, and
repository conventions.

## License

[MIT](LICENSE) © Ariaszzzhc
