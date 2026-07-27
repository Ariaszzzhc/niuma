// Fetch tunnel over MessageChannel.
//
// The CLI's one-shot mode runs the server (Hono app + Effect runtime + agent
// loop) inside a Deno Worker, while the frontend (the CLI's own run logic)
// stays on the main thread. The two communicate via a fake `fetch`: every
// request the frontend issues is serialised to a plain JSON message, posted
// through a MessagePort, and dispatched to `app.fetch(new Request(...))` in
// the worker. The Response — status, headers, and a streaming body — is
// serialised back as a sequence of chunk messages that the frontend
// reassembles into a real Response.
//
// Why serialise: structured clone (used by postMessage) does NOT clone
// Request/Response objects. We hand-roll a tiny text-only protocol: bodies
// are UTF-8 strings, chunked for streaming responses. The protocol supports
// CONCURRENT in-flight requests (events SSE stream + approval POSTs at the
// same time) — each request carries a unique id and the frontend tracks a
// Map<id, {resolve, reject, controller}>.

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

// Frontend → Worker.
export type TunnelOut =
  | {
    kind: "init";
    port: MessagePort;
    mockProvider?: boolean;
    /** Raw provider/model-id ref resolved from --model/config.toml. The
     * worker's bootstrap binds its provider + default model to this ref so a
     * one-shot `--model other/x` actually switches provider, not just the
     * model id recorded on the session. */
    defaultModelRef?: string;
  }
  | TunnelRequest
  | { kind: "cancel"; id: string }
  | { kind: "shutdown" };

export interface TunnelRequest {
  kind: "request";
  id: string;
  method: string;
  url: string;
  headers: Array<[string, string]>;
  body: string | null;
}

// Worker → Frontend.
export type TunnelIn =
  | { kind: "ready" }
  | { kind: "init_error"; message: string }
  | { kind: "closed" }
  | {
    kind: "response";
    id: string;
    status: number;
    headers: Array<[string, string]>;
  }
  | { kind: "chunk"; id: string; value: string }
  | { kind: "end"; id: string }
  | { kind: "error"; id: string; message: string };

// Skip hop-by-hop / length headers when round-tripping: the worker constructs
// fresh Request/Response objects and the underlying transport re-derives
// these. Carrying them across would cause duplicate / mismatched values.
const SKIP_HEADERS = new Set([
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

const shouldKeepHeader = (name: string): boolean =>
  !SKIP_HEADERS.has(name.toLowerCase());

// ---------------------------------------------------------------------------
// Frontend side: createTunnelFetch + setupTunnel
// ---------------------------------------------------------------------------

export interface TunnelFetch {
  /** A fetch-shaped function whose requests are tunnelled to the worker. */
  readonly fetch: typeof fetch;
  /** Resolves once the worker signals it is ready; rejects on init failure. */
  readonly ready: Promise<void>;
  /** Explicitly cancel an in-flight request (idempotent, no-op if unknown). */
  readonly cancel: (id: string) => void;
  /** Ask the worker to release its server resources. Idempotent. */
  readonly close: () => Promise<void>;
  /** The underlying port — exposed so callers can detach it on shutdown. */
  readonly port: MessagePort;
  /** The worker handle — exposed so callers can terminate it on shutdown. */
  readonly worker: Worker;
}

interface Inflight {
  resolve: (res: Response) => void;
  reject: (err: unknown) => void;
  controller: ReadableStreamDefaultController<Uint8Array> | undefined;
}

/**
 * Wires a Worker + MessagePort pair into a fetch-shaped function.
 *
 * Caller responsibilities:
 *   1. Construct the worker first.
 *   2. Call setupTunnel(worker) — it creates the MessageChannel, transfers
 *      port1 to the worker via an `{kind:"init"}` message, and wires
 *      port2.onmessage to the tunnel protocol.
 *   3. Await `.ready` before issuing any requests.
 *   4. On completion, `worker.terminate()` and `Deno.exit(code)`.
 *
 * Worker errors propagate via the `ready` promise (if during init) and via
 * rejection of every in-flight request (if mid-run). The caller's
 * worker.onerror is also wired to Deno.exit(1) for safety.
 */
export const setupTunnel = (
  worker: Worker,
  opts: { mockProvider?: boolean; defaultModelRef?: string } = {},
): TunnelFetch => {
  const channel = new MessageChannel();
  const port = channel.port2;
  const inflight = new Map<string, Inflight>();

  let readyResolve!: () => void;
  let readyReject!: (err: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  let closedResolve!: () => void;
  const closed = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });

  const onMessage = (ev: MessageEvent) => {
    const msg = ev.data as TunnelIn | undefined;
    if (!msg || typeof msg !== "object") return;

    // Lifecycle messages have no `id`.
    if (msg.kind === "ready") {
      readyResolve();
      return;
    }
    if (msg.kind === "init_error") {
      readyReject(new Error(msg.message));
      closedResolve();
      return;
    }
    if (msg.kind === "closed") {
      closedResolve();
      return;
    }

    const entry = inflight.get(msg.id);
    if (!entry) return;

    switch (msg.kind) {
      case "response": {
        const headers = new Headers();
        for (const [k, v] of msg.headers) headers.set(k, v);
        // The ReadableStream's `start` runs synchronously during construction,
        // so by the time we hand the Response to the resolver the controller
        // is already populated and stored on the entry. Chunk messages that
        // arrive on later ticks will find it.
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            entry.controller = controller;
          },
          cancel() {
            // Consumer gave up — tell the worker to stop pumping. Worker
            // ignores unknown ids, so this is safe even after end.
            port.postMessage(
              { kind: "cancel", id: msg.id } satisfies TunnelOut,
            );
          },
        });
        const res = new Response(body, {
          status: msg.status,
          headers,
        });
        entry.resolve(res);
        return;
      }
      case "chunk": {
        const bytes = new TextEncoder().encode(msg.value);
        try {
          entry.controller?.enqueue(bytes);
        } catch {
          // Controller may be closed/errored; ignore.
        }
        return;
      }
      case "end": {
        try {
          entry.controller?.close();
        } catch {
          // Already closed; ignore.
        }
        inflight.delete(msg.id);
        return;
      }
      case "error": {
        const err = new Error(msg.message);
        try {
          entry.controller?.error(err);
        } catch {
          // Controller may not yet exist (error before response headers).
          // Fall back to rejecting the response promise.
          entry.reject(err);
        }
        inflight.delete(msg.id);
        return;
      }
    }
  };

  // Assigning onmessage implicitly starts the port, so we cannot miss the
  // `ready` frame even if the worker fires it before we finish wiring.
  port.onmessage = onMessage;

  // Use addEventListener (not onerror assignment) so the caller can install
  // its own error handler without replacing this one. Both listeners fire.
  worker.addEventListener("error", (e: ErrorEvent) => {
    const message = e.message ?? "unknown worker error";
    console.error(`niuma: server worker error: ${message}`);
    readyReject(new Error(message));
    for (const entry of inflight.values()) {
      entry.reject(new Error(`server worker error: ${message}`));
    }
    inflight.clear();
    closedResolve();
    // The caller is responsible for calling Deno.exit; we only signal.
  });

  // Hand port1 to the worker. The transfer list detaches port1 in this
  // thread; only the worker may post through it from now on. The optional
  // mockProvider flag is the smoke harness's injection channel;
  // defaultModelRef carries the one-shot's resolved model ref so the worker
  // binds the right provider.
  worker.postMessage(
    {
      kind: "init",
      port: channel.port1,
      ...(opts.mockProvider === true ? { mockProvider: true } : {}),
      ...(opts.defaultModelRef !== undefined
        ? { defaultModelRef: opts.defaultModelRef }
        : {}),
    } satisfies TunnelOut,
    [channel.port1],
  );

  const tunnelFetch: typeof fetch = async (input, init) => {
    // Always await `ready` before issuing a request: the worker is still
    // booting the Effect runtime until the handshake completes. Awaiting
    // serialises the first request, which is what we want.
    await ready;
    const req = new Request(input, init);
    const id = crypto.randomUUID();

    // Drain the body into a string once. All CLI/server bodies are UTF-8
    // text (JSON or SSE) — string payloads are sufficient.
    let body: string | null = null;
    if (req.method !== "GET" && req.method !== "HEAD") {
      body = await req.text();
    }
    const headers: Array<[string, string]> = [];
    req.headers.forEach((value, name) => {
      if (shouldKeepHeader(name)) headers.push([name, value]);
    });

    return await new Promise<Response>((resolve, reject) => {
      inflight.set(id, { resolve, reject, controller: undefined });
      port.postMessage(
        {
          kind: "request",
          id,
          method: req.method,
          url: req.url,
          headers,
          body,
        } satisfies TunnelOut,
      );
    });
  };

  const cancel = (id: string): void => {
    if (!inflight.has(id)) return;
    port.postMessage({ kind: "cancel", id } satisfies TunnelOut);
  };

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      try {
        await ready;
        port.postMessage({ kind: "shutdown" } satisfies TunnelOut);
        await waitForClose(closed);
      } finally {
        port.close();
      }
    })();
    return closing;
  };

  return { fetch: tunnelFetch, ready, cancel, close, port, worker };
};

const waitForClose = async (closed: Promise<void>): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closed,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 2_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

// ---------------------------------------------------------------------------
// Worker side: handleTunnelRequest + runTunnelWorker
// ---------------------------------------------------------------------------

type AppFetch = (request: Request) => Promise<Response>;

/**
 * Dispatch a single tunnelled request through `app.fetch` and stream the
 * Response body back to the frontend as chunk messages.
 *
 * Designed to be called from inside the worker's MessagePort message
 * handler. Concurrent calls are safe — each request has its own id and
 * own reader.
 */
export const handleTunnelRequest = async (
  port: MessagePort,
  msg: TunnelRequest,
  appFetch: AppFetch,
  active: Map<string, ReadableStreamDefaultReader<Uint8Array>>,
): Promise<void> => {
  const { id, method, url, headers, body } = msg;
  const respond = (m: TunnelIn) => port.postMessage(m);

  try {
    const reqHeaders = new Headers();
    for (const [k, v] of headers) reqHeaders.set(k, v);
    const init: RequestInit = { method, headers: reqHeaders };
    if (body !== null) init.body = body;

    const res = await appFetch(new Request(url, init));

    const resHeaders: Array<[string, string]> = [];
    res.headers.forEach((value, name) => {
      if (shouldKeepHeader(name)) resHeaders.push([name, value]);
    });
    respond({
      kind: "response",
      id,
      status: res.status,
      headers: resHeaders,
    });

    if (!res.body) {
      respond({ kind: "end", id });
      return;
    }

    const reader = res.body.getReader();
    active.set(id, reader);
    const decoder = new TextDecoder();
    try {
      // Pump chunks until the underlying stream is exhausted. Using
      // `stream: true` keeps multi-byte UTF-8 sequences intact across
      // chunk boundaries.
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text.length > 0) respond({ kind: "chunk", id, value: text });
      }
      const tail = decoder.decode();
      if (tail.length > 0) respond({ kind: "chunk", id, value: tail });
      respond({ kind: "end", id });
    } finally {
      active.delete(id);
    }
  } catch (err) {
    respond({ kind: "error", id, message: errorMessage(err) });
    active.delete(id);
  }
};

const errorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
};
