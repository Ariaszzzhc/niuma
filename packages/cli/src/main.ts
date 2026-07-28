// niuma CLI entrypoint.
//
// Three subcommands share this entrypoint:
//   - interactive (default): bare `niuma` or `niuma tui` -> the TUI. Wired in
//     interactive.ts via runTui; dispatch just delegates.
//   - one-shot: `niuma -p <prompt>` -> run a single prompt, print the answer.
//   - serve: `niuma serve` -> run the HTTP + SSE server on the main thread.
//
// One-shot mode wiring (the worker bootstrap lives in worker.ts):
//   1. Forward the raw --model override, if any, to the Server Worker.
//   2. setEnvIfAbsent NIUMA_WORKSPACE (inherited by the worker).
//   3. spawnServerWorker(): Worker + fetch tunnel + ready handshake.
//   4. runOneshot(prompt, fetch=tunnel.fetch).
//   5. worker.terminate() + return exit code.
//
// Serve mode runs on the main thread with no worker.

import { parseCliArgs } from "./args.ts";
import { runOneshot } from "./run.ts";
import { runServe } from "./serve.ts";
import { runAuth } from "./auth_cmd.ts";
import { spawnServerWorker } from "./worker.ts";
import { runInteractive } from "./interactive.ts";

// Configuration comes from config.toml (+ auth.json for credentials) — see
// @niuma/config. There is deliberately no .env loading and no NIUMA_* env
// configuration surface; the only env overrides left are NIUMA_DATA_DIR /
// NIUMA_CONFIG (paths) and NIUMA_WORKSPACE (main->worker side-channel).

const main = async (): Promise<number> => {
  const parsed = parseCliArgs(Deno.args);
  if (!parsed.ok) {
    return parsed.exitCode;
  }

  if (parsed.args.subcommand === "serve") {
    return await runServe({
      port: parsed.args.port,
      host: parsed.args.host,
    });
  }

  if (parsed.args.subcommand === "interactive") {
    return await runInteractive(parsed.args);
  }

  if (parsed.args.subcommand === "auth") {
    return await runAuth(parsed.args);
  }

  // One-shot mode.
  const { bypassPermissions, prompt, workspace, mockProvider } = parsed.args;

  // The CLI never reads config.toml. The Server Worker resolves its effective
  // config and validates this optional raw provider/model-id override.
  const modelRef = mockProvider ? undefined : parsed.args.model;

  // Propagate the resolved workspace to the worker's bootstrap: the
  // permission engine reads NIUMA_WORKSPACE at startup to set its cwd, so
  // rule evaluation aligns with the session's workspace rather than the
  // CLI's launch dir. Setting it here is inherited by the worker because
  // Workers snapshot the parent env at spawn time.
  setEnvIfAbsent("NIUMA_WORKSPACE", workspace);

  const spawned = await spawnServerWorker({
    mockProvider,
    ...(modelRef !== undefined ? { modelRef } : {}),
  });
  if (!spawned.ok) {
    return spawned.exitCode;
  }
  const { tunnel } = spawned;

  let exitCode: number;
  try {
    const result = await runOneshot(
      {
        prompt,
        workspace,
        bypassPermissions,
      },
      tunnel.fetch,
    );
    exitCode = result.exitCode;
  } catch (err) {
    console.error(
      `niuma: one-shot run failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    exitCode = 1;
  } finally {
    // Ask the worker to dispose its runtime, MCP transports, and projection
    // before terminating the isolate.
    try {
      await tunnel.close();
    } catch {
      // The hard termination below remains the final safety net.
    }
    try {
      tunnel.worker.terminate();
    } catch {
      // ignore
    }
  }

  return exitCode;
};

const setEnvIfAbsent = (name: string, value: string): void => {
  if (!Deno.env.get(name)) {
    try {
      Deno.env.set(name, value);
    } catch {
      // Best-effort; ignore if env is not writable.
    }
  }
};

if (import.meta.main) {
  const code = await main();
  // Explicit exit so any lingering worker fibers or open file handles do
  // not keep the process alive past the final answer.
  Deno.exit(code);
}
