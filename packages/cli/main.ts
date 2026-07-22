// niuma CLI entrypoint.
//
// One-shot mode wiring:
//   1. Build the Worker URL relative to this module.
//   2. Spawn the worker (module type, inheriting the CLI's permissions).
//   3. setupTunnel(): create a MessageChannel, transfer port1 to the worker,
//      keep port2 on the main thread and expose a fetch-shaped function.
//   4. Await tunnel.ready (worker has booted createServerApp).
//   5. runOneshot(prompt, fetch=tunnel.fetch).
//   6. worker.terminate() + Deno.exit(code).
//
// Serve mode runs on the main thread with no worker.

import { parseCliArgs } from "./args.ts";
import { runOneshot } from "./run.ts";
import { runServe } from "./serve.ts";
import { setupTunnel } from "./tunnel.ts";
import { load } from "@std/dotenv";

// Load .env from cwd before anything reads Deno.env (provider config, model
// defaults). Existing environment variables win over .env values. NOTE:
// load() is async — without await the env vars land after arg parsing has
// already fallen back to defaults.
try {
  await load({ export: true });
} catch {
  // No .env present — fine, env may come from the shell.
}

const WORKER_URL = new URL("./server-worker.ts", import.meta.url);

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

  // One-shot mode.
  const { prompt, workspace, model } = parsed.args;

  // Propagate the resolved workspace to the worker's bootstrap: the
  // permission engine reads NIUMA_WORKSPACE at startup to set its cwd, so
  // rule evaluation aligns with the session's workspace rather than the
  // CLI's launch dir. Setting it here is inherited by the worker because
  // Workers snapshot the parent env at spawn time.
  setEnvIfAbsent("NIUMA_WORKSPACE", workspace);
  // Keep the provider default in sync with the per-session model override
  // so the spawn_subagent closure and the session both target the same model.
  setEnvIfAbsent("NIUMA_MODEL", model);

  // Spawn the server worker. permissions:"inherit" gives it the same
  // --allow-all surface the CLI itself runs with (Deno permissions are NOT
  // the security model — the agent's permission chain is).
  const worker = new Worker(WORKER_URL, {
    type: "module",
    deno: { permissions: "inherit" },
  });

  const tunnel = setupTunnel(worker);

  // Await the ready handshake (or surface an init failure). The worker
  // posts {kind:"ready"} once createServerApp resolves, or {kind:"init_error"}
  // (followed by an onerror) on failure.
  try {
    await tunnel.ready;
  } catch (err) {
    console.error(
      `niuma: server worker failed to start: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    try {
      tunnel.worker.terminate();
    } catch {
      // ignore
    }
    return 1;
  }

  // The worker also wires its own onerror to reject in-flight requests and
  // the ready promise; we install a top-level listener (addEventListener, so
  // it composes with the tunnel's internal handler) so a mid-run worker
  // crash still terminates the process.
  tunnel.worker.addEventListener("error", (e: ErrorEvent) => {
    console.error(`niuma: server worker crashed: ${e.message ?? e}`);
    try {
      tunnel.worker.terminate();
    } catch {
      // ignore
    }
    Deno.exit(1);
  });

  let exitCode: number;
  try {
    const result = await runOneshot(
      { prompt, workspace, model },
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
    // Tear down the worker regardless of outcome — leaking a background
    // fiber that owns the SQLite projection / event bus is worse than a
    // clean shutdown. The JSONL log is already flushed.
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
