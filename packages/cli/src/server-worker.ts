// Server-side Worker module.
//
// Spawned from the main thread via:
//   new Worker(new URL("./server-worker.ts", import.meta.url), {
//     type: "module",
//     deno: { permissions: "inherit" },
//   });
//
// Receives a transferred MessagePort via an `{kind:"init"}` message, boots
// the full server (bootstrap + createServerApp), and dispatches incoming
// `{kind:"request"}` messages to `app.fetch`. Responses are streamed back
// as `{kind:"response" | "chunk" | "end" | "error"}` messages per the
// tunnel protocol defined in ./tunnel.ts.
//
// All logging is redirected to stderr (logtape's default console sink would
// pollute stdout, which the one-shot flow reserves for the final answer).

import { bootstrap, createServerApp, setupLogger } from "@niuma/server";
import { parseConfig } from "@niuma/config";
import { makeMockProvider } from "@niuma/provider";
import {
  handleTunnelRequest,
  type TunnelIn,
  type TunnelOut,
  type TunnelRequest,
} from "./tunnel.ts";

// Active body readers, indexed by request id. Tracked so a `{kind:"cancel"}`
// from the frontend can abort the pump on the worker side and trigger Hono's
// streamSSE onAbort cleanup.
const activeReaders = new Map<
  string,
  ReadableStreamDefaultReader<Uint8Array>
>();

// Extended init shape for the smoke harness: `mockProvider: true` injects
// the scripted network-free provider through bootstrap deps, replacing the
// old NIUMA_MOCK_PROVIDER env switch. Production CLI spawns never set it.
// (The flag is declared on TunnelOut's init variant in tunnel.ts.)

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data as TunnelOut | undefined;
  if (!msg || typeof msg !== "object") return;

  if (msg.kind === "init") {
    const port: MessagePort = msg.port;
    try {
      // stderr console + JSON-lines file under <data>/log; level from
      // [core] log_level in config.toml.
      await setupLogger({ console: "stderr" });
      const app = msg.mockProvider === true
        ? (await createServerApp({
          bootstrap: await bootstrap({
            config: parseConfig(""),
            infra: { provider: makeMockProvider() },
          }),
        })).app
        : (await createServerApp()).app;
      const appFetch = app.fetch.bind(app) as (
        request: Request,
      ) => Promise<Response>;

      // Request loop. Each message is dispatched concurrently — the tunnel
      // is designed for concurrent in-flight requests (SSE stream + approval
      // POST in parallel).
      port.onmessage = (ev: MessageEvent) => {
        const inner = ev.data as TunnelOut | undefined;
        if (!inner || typeof inner !== "object") return;
        switch (inner.kind) {
          case "request": {
            // Fire-and-forget; handleTunnelRequest serialises the response
            // back through the port.
            void handleTunnelRequest(
              port,
              inner as TunnelRequest,
              appFetch,
              activeReaders,
            );
            return;
          }
          case "cancel": {
            const reader = activeReaders.get(inner.id);
            if (reader) {
              try {
                void reader.cancel("frontend cancelled");
              } catch {
                // Ignore — the pump loop will observe the rejection.
              }
            }
            return;
          }
          default: {
            return;
          }
        }
      };

      port.postMessage({ kind: "ready" } satisfies TunnelIn);
    } catch (err) {
      // Bootstrap failed. Surface the message to the frontend (so the
      // ready promise rejects with a useful error) and re-throw so the
      // worker.onerror handler on the main thread also fires.
      const message = err instanceof Error ? err.message : String(err);
      try {
        port.postMessage({ kind: "init_error", message } satisfies TunnelIn);
      } catch {
        // Port may not be in a deliverable state yet; ignore.
      }
      throw err;
    }
  }
};
