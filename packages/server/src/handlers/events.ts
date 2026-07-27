import type { Context as HonoContext } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { Effect, type ManagedRuntime, Stream } from "effect";
import { Kernel } from "../kernel.ts";
import type { SessionManager } from "../session.ts";

const HEARTBEAT_MS = 15_000;

type R = Kernel | SessionManager;
type Rt = ManagedRuntime.ManagedRuntime<R, unknown>;

// Kernel.events acquires the live subscription before replaying the JSONL, so
// recorded events appended during the handoff are buffered and deduplicated.
// The resulting stream stays open until the request is aborted. The 15s
// heartbeat interleaves with event frames via setInterval.
export const handleEvents = (
  c: HonoContext,
  runtime: Rt,
): Response | Promise<Response> => {
  const sid = c.req.query("session") ?? "";
  const cursorParam = c.req.query("cursor");

  if (!sid) {
    return c.json(
      {
        error: { code: "bad_request", message: "session query param required" },
      },
      400,
    );
  }
  const cursor = Number(cursorParam ?? "0");
  if (!Number.isFinite(cursor) || cursor < 0) {
    return c.json(
      { error: { code: "bad_request", message: "invalid cursor" } },
      400,
    );
  }

  return streamSSE(c, async (stream: SSEStreamingApi) => {
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let aborted = false;
    const writeFrame = (
      cur: number,
      type: string,
      data: unknown,
    ): Promise<void> =>
      stream.writeSSE({
        id: String(cur),
        event: type,
        data: JSON.stringify(data),
      });

    const onAbort = () => {
      aborted = true;
      if (heartbeat !== null) clearInterval(heartbeat);
      heartbeat = null;
    };
    stream.onAbort(onAbort);
    heartbeat = setInterval(() => {
      if (aborted) return;
      void stream.writeSSE({ data: "hb", event: "ping" });
    }, HEARTBEAT_MS);

    try {
      const events = await runtime.runPromise(
        Effect.gen(function* () {
          const k = yield* Kernel;
          return k.events(sid, cursor);
        }),
      );
      await runtime.runPromise(
        Stream.runForEach(events, (sse) => {
          if (aborted) return Effect.void;
          return Effect.promise(() =>
            writeFrame(sse.cursor, sse.event.type, sse.event)
          );
        }),
      );
    } catch (e) {
      // The stream was likely interrupted by the client closing the
      // connection. Surface nothing — the abort path has already torn down
      // the heartbeat.
      void e;
    } finally {
      onAbort();
    }
  });
};
