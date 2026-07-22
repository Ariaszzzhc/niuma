import { createServerApp } from "./app.ts";
import { setupLogger, log } from "./logger.ts";

if (import.meta.main) {
  const port = Number(Deno.env.get("NIUMA_PORT") ?? "4096");
  const host = Deno.env.get("NIUMA_HOST") ?? "127.0.0.1";
  await setupLogger();
  const { app } = await createServerApp();
  log("niuma.server").info("serving on http://{host}:{port}", { host, port });
  Deno.serve({ port, hostname: host }, app.fetch);
}