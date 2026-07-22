// `niuma serve` — local HTTP + SSE server.
//
// Unlike one-shot mode, the serve subcommand runs the server on the MAIN
// thread and exposes it over plain TCP via Deno.serve. Remote HTTP clients
// (curl, web frontends, other CLI invocations) hit it directly; there is no
// fetch tunnel here. The dual-execution tunnel is reserved for the one-shot
// flow where the frontend (CLI) and server share a process.

import { setupLogger, log, createServerApp } from "@niuma/server";

export interface ServeOptions {
  readonly port: number;
  readonly host: string;
}

export const runServe = async (opts: ServeOptions): Promise<number> => {
  // Logger goes to stdout via logtape's console sink — fine for a long-running
  // server process where there is no "final answer" reservation.
  await setupLogger();

  let app;
  try {
    app = await createServerApp();
  } catch (err) {
    console.error(
      `niuma: failed to boot server: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 1;
  }

  // Bind app.fetch so the handler does not lose `this` when Deno.serve
  // invokes it as a bare function.
  const handler = app.app.fetch.bind(app.app) as (
    req: Request,
  ) => Promise<Response>;

  const server = Deno.serve(
    { port: opts.port, hostname: opts.host },
    handler,
  );

  log("niuma.server").info(
    "serving on http://{host}:{port}",
    { host: opts.host, port: opts.port },
  );
  console.error(
    `niuma: serving on http://${opts.host}:${opts.port} (Ctrl+C to stop)`,
  );

  // Graceful shutdown on SIGINT (and SIGTERM on Unix). Deno.serve.shutdown()
  // drains in-flight connections before exiting.
  const shutdown = () => {
    console.error("niuma: shutting down…");
    void server.shutdown();
  };
  Deno.addSignalListener("SIGINT", shutdown);
  // SIGTERM exists on Unix; the listener registration throws on Windows so
  // guard it.
  try {
    Deno.addSignalListener("SIGTERM", shutdown);
  } catch {
    // Platform does not support SIGTERM — skip silently.
  }

  try {
    await server.finished;
  } finally {
    try {
      Deno.removeSignalListener("SIGINT", shutdown);
    } catch {
      // Already removed.
    }
    try {
      Deno.removeSignalListener("SIGTERM", shutdown);
    } catch {
      // Platform without SIGTERM or already removed.
    }
  }

  return 0;
};
