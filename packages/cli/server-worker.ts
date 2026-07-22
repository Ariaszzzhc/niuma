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

import { configure, getStreamSink } from "@logtape/logtape";
import { createServerApp } from "@niuma/server";
import {
  handleTunnelRequest,
  type TunnelIn,
  type TunnelOut,
  type TunnelRequest,
} from "./tunnel.ts";

let loggingConfigured = false;

const setupWorkerLogging = async (): Promise<void> => {
  if (loggingConfigured) return;
  loggingConfigured = true;
  // Default to `warning` so the chatty HTTP access log never reaches stdout.
  // Operator can opt into more detail via NIUMA_LOG=trace|debug|info|...
  const level = (Deno.env.get("NIUMA_LOG") ?? "warning") as
    | "trace"
    | "debug"
    | "info"
    | "warning"
    | "error"
    | "fatal";
  try {
    await configure({
      sinks: {
        // Deno.stderr.writable is a WritableStream — logtape's stream sink
        // consumes it directly.
        stderr: getStreamSink(Deno.stderr.writable),
      },
      filters: {},
      loggers: [
        // Single root category covers all `niuma.*` subcategories.
        { category: ["niuma"], lowestLevel: level, sinks: ["stderr"] },
      ],
    });
  } catch {
    // If logtape was already configured (e.g. a previous worker in the same
    // process), swallow and continue.
  }
};

// Active body readers, indexed by request id. Tracked so a `{kind:"cancel"}`
// from the frontend can abort the pump on the worker side and trigger Hono's
// streamSSE onAbort cleanup.
const activeReaders = new Map<
  string,
  ReadableStreamDefaultReader<Uint8Array>
>();

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data as TunnelOut | undefined;
  if (!msg || typeof msg !== "object") return;

  if (msg.kind === "init") {
    const port: MessagePort = msg.port;
    try {
      await setupWorkerLogging();
      const { app } = await createServerApp();
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
