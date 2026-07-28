# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project overview

**niuma** is an AI coding agent: a Deno + TypeScript monorepo that ships a CLI
with three faces — a fullscreen interactive TUI, a one-shot prompt mode, and an
HTTP+SSE server — all driving the same event-sourced agent core.

The architecture is event-sourced: one append-only JSONL Session Journal per
Session is the only Session source of truth. Journals and long-lived,
content-free Usage Archives are grouped by a readable Claude-style Workspace
Key; there is no operational database. The agent loop, permission engine, and
tool pipeline are decoupled behind port interfaces.
[Effect](https://effect.website) (v4 beta) provides concurrency, streams,
resource scopes, and the server's composition boundary; leaf modules use plain
interfaces rather than parallel service wrappers.

Runtime flow (one-shot mode as an example):

```
CLI (main thread)
  └─ spawns server Worker + in-process fetch tunnel
       └─ Hono HTTP app (packages/server) on an Effect ManagedRuntime
            └─ Kernel: append / replay / subscribe over the Session Journal
                 └─ agent loop (runTurn) → provider stream → tool pipeline
                      └─ permission engine authorizes each tool call
```

The shipped TUI and one-shot modes are Clients in the main isolate of the same
binary; they talk over a fetch-shaped `MessageChannel` tunnel to a Server Worker
in that binary. `serve` exposes the same HTTP+SSE app directly, but is currently
a debugging surface rather than the primary product topology.

## Repository layout

Deno workspace (root `deno.json` lists the members). Each package is
`@niuma/<name>` with the same internal shape: `mod.ts` (explicit public surface,
re-exports only), `src/` (implementation), `tests/` (`*_test.ts`).

| Package               | Role                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/schema`     | Currency types and Effect-Schema codecs for the whole system: domain, events, permission rules, wire protocol, JSONL log format. Exports `SCHEMA_VERSION`.                                                                                                                                                                                                                                                      |
| `packages/provider`   | LLM provider layer: provider-agnostic domain (`ChatRequest`, `Message`, `ToolCall`, `StreamEvent`), adapters for OpenAI chat completions, OpenAI Responses, and Anthropic, plus SSE parsing, retry policy, error taxonomy (`RateLimited`, `Overloaded`, `ContextOverflow`, ...), and a scripted `MockProvider` for network-free tests.                                                                          |
| `packages/permission` | Stateless permission policy primitives: glob compilation/matching, sensitive-path detection, and ordered `allow`/`deny`/`ask` evaluation. The session-scoped mutable engine lives in `packages/tools`.                                                                                                                                                                                                          |
| `packages/tools`      | Built-in tools (`bash`, `read`, `write`, `edit`, `glob`, `grep`, `apply_patch`, `question`, `spawn_subagent`, `update_plan`) under `src/tools/`, plus the tool pipeline (authorize → execute), scheduler, output truncation/spill, and path resolution confined to the workspace root.                                                                                                                          |
| `packages/agent`      | Agent core: `runTurn` loop, event→message context projection (replay folds `compaction.performed`), history compaction/summarization (`compactSession`), system-prompt builder, and the adapter from the agent tool port to `@niuma/tools`. Session and approval lifecycles belong to `packages/server`; the agent depends only on ports (`deps.ts`).                                                            |
| `packages/server`     | HTTP+SSE server (Hono): `WorkspaceLayout`, canonical JSONL `SessionStore`, pure `SessionState` fold, content-free `UsageArchive`, time-based `Retention`, `Kernel` (append/replay/subscribe), Server-owned input coordination and configuration, Session manager (prompt/compact/model/effort), event bus, bootstrap wiring (Effect Layers), handlers for Sessions and events.                                  |
| `packages/config`     | Configuration: `config.toml` parsing, user/project merge and closest-level writes, built-in providers (`builtin.ts`: kimi/openai login-and-go definitions + user-table overlay), `auth.json` credentials (API keys + OAuth), OAuth flows (ChatGPT in `oauth.ts`, Kimi device-code in `kimi_oauth.ts`), MCP config, custom slash commands (`commands/*.md` discovery + template expansion), paths and `VERSION`. |
| `packages/mcp`        | MCP client: connects to configured MCP servers and adapts MCP tools into niuma tools (`@modelcontextprotocol/sdk`).                                                                                                                                                                                                                                                                                              |
| `packages/cli`        | Entrypoint (`src/main.ts`): subcommands `tui` (default), `-p` one-shot, `serve`, `auth`; argument parsing; server-worker spawn + fetch tunnel; stdin approval plumbing.                                                                                                                                                                                                                                         |
| `packages/tuikit`     | Terminal toolkit: TEA-style `run` loop, `Frame`, `KeyParser`, `Terminal`, width/style helpers. Hot paths (width, cell buffer, diff, keys, SGR) live in a Rust cdylib (`native/`) loaded via `Deno.dlopen`; `src/binding_contract.ts` is the authoritative FFI symbol contract.                                                                                                                                  |
| `packages/tui`        | Interactive TUI: `runTui` entrypoint, built-in slash command dispatch (`src/commands.ts`), components (welcome, transcript/thinking, specialized tool renderers, editor, completion, footer, bottom approval/question/command surfaces), theme detection, markdown rendering, multi-session SSE client.                                                                                                         |
| `scripts/smoke.ts`    | Network-free end-to-end smoke test (see below).                                                                                                                                                                                                                                                                                                                                                                 |

Dependency direction: `schema` is the base; `provider`, `permission`, and
`config` sit above it; `tools`/`agent`/`mcp` compose those; `server` owns
persistence and wires everything; `cli`/`tui` are the delivery surfaces. Lower
packages must not import from higher ones. Cross-package imports always go
through the `@niuma/*` aliases from the root import map — never relative paths
that escape the package.

## Build, run, and test commands

All commands run from the repo root. Requires Deno 2.x (developed on 2.7) and,
for the native library, a Rust toolchain (cargo).

```sh
deno task check          # type-check all package mod.ts + CLI entrypoint
deno task test           # full test suite: deno test --allow-all --unstable-worker-options packages/
deno task cli -- ...     # run the CLI from source (alias for deno run --allow-all packages/cli/src/main.ts)
deno task build:native   # cargo build --release of packages/tuikit/native (needed before TUI/FFI use)
deno task build          # full pipeline: native build + deno compile -> dist/niuma(.exe), then a binary smoke run
cd packages/tuikit/native
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --all-targets
```

Notes:

- `--unstable-worker-options` is required anywhere tests or the CLI spawn the
  server Worker; don't drop it.
- `deno task cli` argument parsing drops a `--` separator — pass flags directly
  (`deno task cli -p "prompt" --workspace .`), as `scripts/smoke.ts` does.
- The native library is loaded lazily at first FFI call, so `deno task check`
  and non-TUI tests pass without building it. The artifact
  (`libniuma_tuikit.{so,dylib}` / `niuma_tuikit.dll`) is gitignored.
- `deno task build` (`scripts/build.ts`) compiles the CLI with `deno compile`.
  Two `--include` entries are required: `packages/cli/src/server_worker.ts`
  (Deno does NOT auto-embed workers spawned via
  `new Worker(new URL(..., import.meta.url))` — without it the binary fails at
  runtime with "Module not found") and the native cdylib (`ffi.ts` resolves it
  relative to `import.meta.url`, which maps onto the embedded VFS, so dlopen
  keeps working). `--allow-all` and `--unstable-worker-options` are baked in at
  compile time. `--target <triple>` cross-compiles the JS side, but the cdylib
  must match the TARGET platform and already sit in
  `packages/tuikit/native/target/release/`. `dist/` is gitignored.
- There is no CI configuration in the repo at present. The gates are
  `deno fmt --check`, `deno lint`, `deno task check`, `deno task test`, the
  three Rust commands above, the network-free smoke test, and `deno task build`.

## Testing instructions

- Tests live in `packages/<pkg>/tests/` and are named `*_test.ts`. They use
  `Deno.test` with `@std/assert` (a couple of files use `@std/testing/bdd`).
- Run everything with `deno task test`; run one file with
  `deno test --allow-all --unstable-worker-options packages/<pkg>/tests/<file>_test.ts`.
- Tests must be network-free. Use `MockProvider` from `@niuma/provider` for
  anything that would otherwise call an LLM API, and isolate file state with
  temp dirs plus the `NIUMA_DATA_DIR` override (see `scripts/smoke.ts` for the
  pattern). In-memory fakes honour the port interfaces (`SessionJournal`,
  `ToolPipeline`, ...) — `packages/agent/tests/agent_test.ts` is the reference
  example.
- `scripts/smoke.ts` is the end-to-end harness:
  `deno run --allow-all scripts/smoke.ts` spawns the real CLI against a temp
  workspace with the mock provider and a scripted 3-turn flow, feeds the bash
  approval via stdin, asserts on the Workspace-scoped Session Journal and Model
  Call records, and verifies that no obsolete `niuma.db` is created.
- When changing behavior, extend the tests in the same package rather than
  adding new harnesses.

## Code style guidelines

- TypeScript with `strict: true`; Deno-first (JSR `@std/*` + npm via the root
  import map). No new third-party dependencies without discussion.
- House style is functional: `const f = (x): T => ...`, `readonly` interfaces,
  discriminated unions with `{ type, data }` shapes, no classes except where
  Effect services make them idiomatic.
- Use `Effect`/`Stream`/`Layer` where scoped resources, concurrency, or the
  server runtime need them. Elsewhere prefer the existing plain port interfaces;
  do not add a second DI representation for the same capability.
- Every package exposes its public API exclusively through `mod.ts` re-exports;
  internal modules stay under `src/` and are imported with the `./src/` prefix
  inside the package. Don't re-export FFI internals from `@niuma/tuikit`
  (`binding_contract.ts` is types/constants only).
- Modules open with a banner comment explaining the file's role and any
  non-obvious invariants. Keep invariant comments current and remove historical
  implementation notes once the implementation has landed. Lint excludes
  `no-slow-types` deliberately — where a suppression is needed, use
  `// deno-lint-ignore no-slow-types` as the existing code does.
- Match Deno's default formatting (`deno fmt`); keep edits minimal and scoped to
  the package you are changing.

## Configuration and environment

- User data root is `~/.niuma` (override with `NIUMA_DATA_DIR`): it holds
  `config.toml`, `mcp.json`, `auth.json`, `commands/`, `log/`,
  `sessions/<workspace-key>/` (Session Journals + `workspace.json`) and
  `usage/<workspace-key>/` (content-free Usage Archives). A Workspace Key is the
  normalized absolute path flattened with `-`, for example `/Users/a/work` →
  `-Users-a-work`; it is never hashed. Project-level
  `<workspace>/.niuma/config.toml` merges over the user config but never holds
  data.
- Configuration is Server-owned. The CLI/TUI do not read or merge `config.toml`;
  session create/resume responses carry a typed, sanitized `clientConfig` view.
  There is no automatic reload. An explicit runtime update is persisted first
  and then replaces only that Server's in-memory snapshot.
- Top-level `input_delivery = "steer" | "queue"` controls prompts submitted
  while a Turn is active and defaults to `steer`. `/delivery [steer|queue]`
  updates it through `PUT /config/input-delivery`. The write target is the
  closest existing project `.niuma/config.toml` found by the same upward walk
  used for reads; if none exists, the user config (or `NIUMA_CONFIG`) is updated.
  Other TOML content and comments are preserved.
- Prompt admission is coordinated per session by the Server. A response
  disposition is `started`, `steered`, or `queued`; queue entries are FIFO, each
  becomes its own Turn, survive interrupt/failure, and continue automatically.
  Prompts arriving during compaction always queue.
- A Turn-bound input is consumed only when the Server atomically appends its
  `user.message` immediately before the next provider request. On explicit
  interrupt or terminal Turn failure, any accepted but still-unconsumed inputs
  are returned to the Client as original `sourceText` drafts and are never
  auto-submitted. The TUI restores the first only when its editor is empty and
  keeps later drafts in order; if the editor already contains text, it preserves
  that text and discards all inputs returned by that recovery.
- Different niuma processes may share the data directory while working on
  different sessions. Concurrent cross-process mutation of the same session is
  deliberately undefined behavior; do not add locks, leases, or recovery
  machinery for it unless that product decision changes.
- Session discovery and Resume are scoped to the current Workspace. Default
  startup creates a new Session without enumerating Journals. `--resume <id>`
  and TUI `/resume [id]` are the only recovery paths; ID-prefix resolution lists
  filenames before opening exactly one Journal. There is no cross-Workspace
  Resume.
- Optional top-level `session_retention_days = <positive integer>` enables one
  silent background, age-only Retention sweep. It first atomically writes and
  verifies a content-free Usage Archive, then deletes the expired Session
  Journal. The setting is disabled when absent; Usage Archives never expire.
- Every agent, subagent, and compaction sampling operation records exactly one
  terminal `model.call.completed` or `model.call.failed` event. Missing provider
  token counts remain `null`, never fabricated zeroes.
- Custom slash commands are markdown prompt templates: user-level
  `~/.niuma/commands/*.md` plus project-level `<dir>/.niuma/commands/*.md` (same
  upward discovery + closest-wins merge as `config.toml`/`mcp.json`). Optional
  frontmatter: `description`, `argument-hint`. The body supports `$ARGUMENTS`
  and `$1..$N` placeholders (the highest-numbered one swallows the remaining
  args). `/name args` is expanded server-side (`packages/server/src/session.ts`)
  into the user message before the turn; the typed input survives as
  `sourceText` on the `user.message` event, and an unmatched `/whatever` passes
  through as plain text. The TUI palette (ctrl+p) lists them and seeds the
  editor with `/name`.
- Slash-command completion menu (`packages/tui/src/components/completion.ts`):
  typing a `/partial` token auto-pops a candidate list above the editor
  (built-ins + aliases + custom commands, prefix-filtered live via
  `slashCommandCandidates` in `packages/tui/src/commands.ts`). Tab accepts the
  selection (`/name`), enter accepts AND submits, esc dismisses (typing re-arms,
  tab re-opens), up/down + ctrl+p/ctrl+n navigate while it is open — otherwise
  the arrows stay editor history keys. Keyboard focus never leaves the editor;
  there is no focus switching.
- Built-in slash commands (`packages/tui/src/commands.ts` registry) are
  dispatched TUI-locally on submit and take priority over same-named custom
  commands: `/help`, `/exit` (alias `/quit`), `/model [ref]` (server
  `POST /sessions/:id/model`; persists as an event, rebuilds the provider
  adapter on cross-provider refs), `/effort [level]` (server
  `POST /sessions/:id/effort`; per-session thinking override),
  `/delivery [mode]` (Server config read/write; mode is `steer` or `queue`),
  `/compact` (server `POST /sessions/:id/compact` → `compactSession` in
  `@niuma/agent`; `compaction.performed` carries the summary so replay folds
  history across turns), `/clear` (new session), `/resume [id]` (list /
  re-attach a current-Workspace Session and rebuild from its Journal), `/mcp`
  (list MCP servers). Their output renders as `notice` rows in the transcript.
- Model selection is `provider/model-id` via `--model` or the top-level `model`
  key in `config.toml`; credentials live in `auth.json` (managed by
  `niuma auth login|logout|status`).
- Built-in providers (`packages/config/src/builtin.ts`) make login-and-go work:
  `niuma auth login kimi` (Kimi device-code OAuth against `auth.kimi.com`, tokens
  valid against `https://api.kimi.com/coding/v1`; a pasted Kimi API key instead
  targets the open platform `https://api.moonshot.cn/v1` — the credential kind
  picks both the endpoint and the default model) and `niuma auth login openai`
  (ChatGPT) need NO `[provider.*]` table. When neither `--model` nor config
  `model` is set, the unique logged-in built-in supplies the default model ref.
  A same-named `[provider.<id>]` table in `config.toml` overlays the built-in
  (scalar fields and per-model entries, user wins); provider tables otherwise
  declare custom providers. OAuth credentials are legal for `type="responses"`
  providers and for the built-in `kimi` provider's `type="openai"` lane; any
  other pairing is a ConfigError at bootstrap.
- Deliberately small env surface: `NIUMA_DATA_DIR`, `NIUMA_CONFIG`,
  `NIUMA_WORKSPACE` (main→worker side-channel). There is no `.env` loading —
  don't add one.
- CLI grammar: `niuma` / `niuma tui` (interactive, needs a TTY),
  `niuma -p
  <prompt>` (one-shot), `niuma serve --port <port>` (debug HTTP+SSE
  server), `niuma
  auth <action>`; `--mock-provider` exists for the smoke
  harness only.

## Security considerations

- Every tool call passes through `@niuma/tools`' permission engine, backed by
  `@niuma/permission`'s ordered policy and sensitive-path primitives. Preserve
  this — never add a code path that executes a tool without authorization.
- Path tools resolve strictly within the workspace root (`resolvePath` /
  `resolveWithinRoot` in `@niuma/tools`); keep that confinement intact.
- `auth.json` contains credentials: never log token material, and keep
  `niuma auth status`-style output metadata-only.
- The FFI boundary (`packages/tuikit/native`) has a panic-safety contract —
  every `extern fn` must `catch_unwind` and return the sentinel; the TS side
  (`ffi.ts`) raises `TuikitError` on it. The crate intentionally has no external
  dependencies except `windows-sys`.
- The HTTP server validates session ids and binds locally by default; keep input
  validation in `handlers/` when adding endpoints.

## Current Status

The project is currently under active development and has not had any official
releases yet. Do not introduce backward compatibility code, technical debt, or
data migration logic. The former flat Session directory and `niuma.db` have no
reader or migration path. If any corrupted user data is found in niuma, simply
delete the corrupted data.
