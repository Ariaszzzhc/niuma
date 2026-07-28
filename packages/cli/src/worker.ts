// Server-worker bootstrap, shared by the one-shot and interactive frontends.
//
// Both frontends drive the exact same in-process server: a Deno Worker running
// `server_worker.ts` (Hono app + Effect runtime + agent loop), reached through
// the MessageChannel fetch tunnel defined in `tunnel.ts`. The wiring is fiddly
// and identical for both callers, so it lives here:
//
//   1. Spawn the worker (module type, inheriting the CLI's permissions).
//   2. setupTunnel(): create a MessageChannel, transfer port1 to the worker,
//      keep port2 on the main thread and expose a fetch-shaped function.
//   3. Await tunnel.ready (worker has booted createServerApp).
//   4. Install a top-level worker error listener so a mid-run crash still
//      terminates the process.
//
// permissions:"inherit" gives the worker the same --allow-all surface the CLI
// itself runs with (Deno permissions are NOT the security model — the agent's
// permission chain is).

import { setupTunnel, type TunnelFetch } from "./tunnel.ts";

const WORKER_URL = new URL("./server_worker.ts", import.meta.url);

export interface SpawnServerWorkerOpts {
  /** Smoke-harness only: inject the scripted network-free provider. */
  readonly mockProvider: boolean;
  /** Raw provider/model-id from the Client's explicit --model override. The
   * Server resolves config.toml itself when this is absent. */
  readonly modelRef?: string;
}

export interface SpawnedServerWorker {
  /** The fetch tunnel over the worker's MessagePort. */
  readonly tunnel: TunnelFetch;
  /** The worker handle (same reference as `tunnel.worker`). */
  readonly worker: Worker;
}

export type SpawnServerWorkerResult =
  | ({ readonly ok: true } & SpawnedServerWorker)
  // The ready handshake failed: the "failed to start" diagnostic has already
  // been printed and the worker terminated; the caller should just bail with
  // this exit code. Centralising the message here keeps the one-shot and TUI
  // frontends byte-for-byte identical on init failure.
  | { readonly ok: false; readonly exitCode: number };

/**
 * Spawn the server worker, wire its fetch tunnel, await the ready handshake,
 * and install a crash listener.
 *
 * On a ready-handshake failure, prints `niuma: server worker failed to start:
 * <msg>`, terminates the worker, and returns `{ ok: false, exitCode: 1 }` so
 * the caller can return without duplicating the diagnostic.
 *
 * On success, installs a `worker.addEventListener("error")` listener (it
 * composes with the tunnel's internal handler) so a mid-run worker crash
 * prints `niuma: server worker crashed: <msg>` and force-exits the process.
 */
export const spawnServerWorker = async (
  opts: SpawnServerWorkerOpts,
): Promise<SpawnServerWorkerResult> => {
  const worker = new Worker(WORKER_URL, {
    type: "module",
    deno: { permissions: "inherit" },
  });

  const tunnel = setupTunnel(worker, {
    mockProvider: opts.mockProvider,
    ...(opts.modelRef !== undefined ? { defaultModelRef: opts.modelRef } : {}),
  });

  // Await the ready handshake (or surface an init failure). The worker posts
  // {kind:"ready"} once createServerApp resolves, or {kind:"init_error"}
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
    return { ok: false, exitCode: 1 };
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

  return { ok: true, tunnel, worker };
};
