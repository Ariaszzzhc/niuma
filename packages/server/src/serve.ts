import { createServerApp } from "./app.ts";
import { setupLogger, log } from "./logger.ts";

// Direct entrypoint (`deno run packages/server/src/serve.ts`). The supported
// way to run the server is `niuma serve --port/--host`; this file stays as a
// bare-bones dev launcher with the same defaults. Bind address comes from
// the CLI flags there — no environment variables.
if (import.meta.main) {
  const port = 4096;
  const host = "127.0.0.1";
  await setupLogger();
  const { app } = await createServerApp();
  log("niuma.server").info("serving on http://{host}:{port}", { host, port });
  Deno.serve({ port, hostname: host }, app.fetch);
}