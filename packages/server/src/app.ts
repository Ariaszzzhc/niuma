import { Hono } from "hono";
import type { Context as HonoContext } from "hono";
import { Layer, ManagedRuntime } from "effect";
import { VERSION } from "@niuma/config";
import {
  CreateSessionRes,
  decode,
  EventPage,
  GetSessionRes,
  PromptRes,
  SessionListRes,
  SetEffortRes,
  SetModelRes,
} from "@niuma/schema";
import { Kernel } from "./kernel.ts";
import { SessionManager } from "./session.ts";
import { bootstrap, type BootstrapResult } from "./bootstrap.ts";
import { makeHandlers } from "./handlers/sessions.ts";
import { handleEvents } from "./handlers/events.ts";
import { HttpError, httpError } from "./error.ts";
import { log } from "./logger.ts";

const ensureSessionId = (id: string): string => {
  if (!id || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
    throw httpError("bad_request", `invalid session id: ${id}`);
  }
  return id;
};

export interface ServerDeps {
  readonly bootstrap?: BootstrapResult;
  readonly layer?: Layer.Layer<Kernel | SessionManager, never, never>;
}

export interface ServerApp {
  readonly app: Hono;
  readonly kernel: Kernel;
  readonly sessionManager: SessionManager;
  readonly runtime: ManagedRuntime.ManagedRuntime<
    Kernel | SessionManager,
    unknown
  >;
  readonly bootstrap: BootstrapResult;
  /** Dispose the Effect runtime, MCP transports, and projection. Idempotent. */
  readonly close: () => Promise<void>;
}

export const createServerApp = async (
  deps: ServerDeps = {},
): Promise<ServerApp> => {
  const boot = deps.bootstrap ?? await bootstrap();
  // Compose the layers so Kernel is built first, then SessionManager (which
  // requires Kernel). provideMerge keeps both services in the output scope.
  const layer: Layer.Layer<Kernel | SessionManager, never, never> =
    deps.layer ??
      Layer.provideMerge(boot.sessionLayer, boot.kernelLayer);

  const runtime = ManagedRuntime.make(layer);
  const kernel = await runtime.runPromise(Kernel);
  const sessionManager = await runtime.runPromise(SessionManager);
  const handlers = makeHandlers(runtime, {
    ...(boot.infra.globalConfigDir !== undefined
      ? { globalConfigDir: boot.infra.globalConfigDir }
      : {}),
  });

  const app = new Hono();

  // ---- logging middleware (logtape) ----
  const httpLog = log("niuma.server.http");
  app.use("*", async (c, next) => {
    const start = performance.now();
    await next();
    const dur = (performance.now() - start).toFixed(1);
    httpLog.info("{method} {path} → {status} ({dur}ms)", {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      dur,
    });
  });

  // ---- global error handler ----
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json(
        {
          error: {
            code: err.code,
            message: err.message,
            ...(err.details !== undefined ? { details: err.details } : {}),
          },
        },
        err.status as 400,
      );
    }
    httpLog.error("unhandled error: {err}", { err: String(err) });
    return c.json({ error: { code: "internal", message: String(err) } }, 500);
  });

  // ---- routes ----

  app.get("/health", (c) => c.json({ ok: true, version: VERSION }));

  app.post("/sessions", async (c) => {
    const raw = await safeJson(c);
    const out = await handlers.createSession(raw);
    return c.json(decode(CreateSessionRes)(out), 201);
  });

  app.get("/sessions", async (c) => {
    const list = await handlers.listSessions();
    return c.json(decode(SessionListRes)(list));
  });

  app.get("/sessions/:id", async (c) => {
    const id = ensureSessionId(c.req.param("id"));
    const out = await handlers.getSession(id);
    return c.json(decode(GetSessionRes)(out));
  });

  app.post("/sessions/:id/prompt", async (c) => {
    const id = ensureSessionId(c.req.param("id"));
    const raw = await safeJson(c);
    const out = await handlers.prompt(id, raw);
    return c.json(decode(PromptRes)(out), 202);
  });

  app.post("/sessions/:id/interrupt", async (c) => {
    const id = ensureSessionId(c.req.param("id"));
    const out = await handlers.interrupt(id);
    return c.json(out);
  });

  app.post("/sessions/:id/model", async (c) => {
    const id = ensureSessionId(c.req.param("id"));
    const raw = await safeJson(c);
    const out = await handlers.setModel(id, raw);
    return c.json(decode(SetModelRes)(out));
  });

  app.post("/sessions/:id/effort", async (c) => {
    const id = ensureSessionId(c.req.param("id"));
    const raw = await safeJson(c);
    const out = await handlers.setEffort(id, raw);
    return c.json(decode(SetEffortRes)(out));
  });

  app.post("/sessions/:id/compact", async (c) => {
    const id = ensureSessionId(c.req.param("id"));
    const out = await handlers.compact(id);
    return c.json(out, 202);
  });

  app.post("/sessions/:id/approvals/:approvalId", async (c) => {
    const id = ensureSessionId(c.req.param("id"));
    const aid = c.req.param("approvalId");
    if (!aid || !/^[A-Za-z0-9_-]{1,128}$/.test(aid)) {
      throw httpError("bad_request", `invalid approval id: ${aid}`);
    }
    const raw = await safeJson(c);
    const out = await handlers.approval(id, aid, raw);
    return c.json(out);
  });

  app.get("/sessions/:id/history", async (c) => {
    const id = ensureSessionId(c.req.param("id"));
    const out = await handlers.history(id);
    return c.json(decode(EventPage)(out));
  });

  app.get("/events", (c) => handleEvents(c, runtime));

  app.notFound((c) =>
    c.json(
      {
        error: {
          code: "not_found",
          message: `no route for ${c.req.method} ${c.req.path}`,
        },
      },
      404,
    )
  );

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await runtime.dispose();
    } finally {
      await boot.close();
    }
  };

  return {
    app,
    kernel,
    sessionManager,
    runtime,
    bootstrap: boot,
    close,
  };
};

const safeJson = async (c: HonoContext): Promise<unknown> => {
  try {
    return await c.req.json();
  } catch (e) {
    throw httpError("invalid_json", `failed to parse JSON body: ${String(e)}`);
  }
};
