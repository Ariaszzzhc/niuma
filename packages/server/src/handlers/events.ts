import type { Context as HonoContext } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import { Effect, ManagedRuntime, Stream } from "effect";
import { Kernel } from "../kernel.ts";
import { SessionManager } from "../session.ts";

const HEARTBEAT_MS = 15_000;

type R = Kernel | SessionManager;
type Rt = ManagedRuntime.ManagedRuntime<R, unknown>;

// `replay-from-cursor` then `live-tail`. Replay drains the JSONL via the
// kernel; once it exhausts, we hand off to kernel.subscribe(sessionId,
// lastSeq) — a PubSub-backed stream that stays open until the request is
// aborted. The 15s heartbeat interleaves with live frames via setInterval.
export const handleEvents = async (
  c: HonoContext,
  runtime: Rt,
): Promise<Response> => {
  const sid = c.req.query("session") ?? "";
  const cursorParam = c.req.query("cursor");

  if (!sid) {
    return c.json(
      { error: { code: "bad_request", message: "session query param required" } },
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
    const writeFrame = (cur: number, type: string, data: unknown) => {
      void stream.writeSSE({
        id: String(cur),
        event: type,
        data: JSON.stringify(data),
      });
    };

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
      // 1) Drain the JSONL from `cursor` to end-of-log. Track the highest seq
      // we emit so the live tail picks up exactly where replay left off.
      let lastSeq = cursor > 0 ? cursor - 1 : 0;
      const replayStream = await runtime.runPromise(
        Effect.gen(function* () {
          const k = yield* Kernel;
          return k.replay(sid, cursor).pipe(
            Stream.map((event) => ({ cursor: event.seq, event })),
          );
        }),
      );
      await runtime.runPromise(
        Stream.runForEach(replayStream, (sse) => {
          lastSeq = Math.max(lastSeq, sse.cursor);
          writeFrame(sse.cursor, sse.event.type, sse.event);
          return Effect.void;
        }),
      );
      if (aborted) return;

      // 2) Live tail: subscribe to the per-session PubSub starting just after
      // the last replayed seq. Events that arrived between replay exhaustion
      // and subscribe are NOT re-delivered by the bounded PubSub — the next
      // recorded event triggers a fresh delivery. We absorb the small gap in
      // exchange for not having to introduce a sequencing round-trip.
      const liveStream = await runtime.runPromise(
        Effect.gen(function* () {
          const k = yield* Kernel;
          return k.subscribe(sid, lastSeq + 1);
        }),
      );
      await runtime.runPromise(
        Stream.runForEach(liveStream, (sse) => {
          if (aborted) return Effect.void;
          writeFrame(sse.cursor, sse.event.type, sse.event);
          return Effect.void;
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
