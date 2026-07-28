// ===========================================================================
// @niuma/server — prompt admission, interrupt recovery, and FIFO continuation
// ---------------------------------------------------------------------------
// Exercises the Server-owned Input Coordinator through the HTTP surface with
// a controllable, network-free provider. The first provider request can be
// held open so prompts deterministically arrive either as Turn-bound steers or
// future-Turn FIFO entries. This locks the claim/interrupt/failure boundaries
// without depending on timing inside the agent loop.
// ===========================================================================

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { Effect, Option, Stream } from "effect";
import {
  AuthFailed,
  type ChatRequest,
  type ProviderAdapter,
  type StreamEvent,
} from "@niuma/provider";
import { parseConfig } from "@niuma/config";
import type { SseEvent } from "@niuma/schema";
import { createServerApp, type ServerApp } from "../mod.ts";
import { bootstrap } from "../src/bootstrap.ts";

const FINISH: StreamEvent = {
  _tag: "Finish",
  reason: "stop",
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
} as StreamEvent;

interface ControlledProvider {
  readonly adapter: ProviderAdapter;
  readonly calls: ChatRequest[];
  readonly releaseFirst: () => void;
}

/** Hold only the first provider request. Later Turns finish immediately. */
const controlledProvider = (
  firstOutcome: "finish" | "fail" = "finish",
): ControlledProvider => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: ChatRequest[] = [];

  const waitForReleaseOrAbort = (
    signal?: AbortSignal,
  ): Promise<"released" | "aborted"> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (value: "released" | "aborted"): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = (): void => finish("aborted");
      if (signal?.aborted) {
        finish("aborted");
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      void gate.then(() => finish("released"));
    });

  const adapter: ProviderAdapter = {
    listModels: () => Effect.succeed([]),
    stream: (request) => {
      const index = calls.length;
      calls.push(request);
      if (index > 0) {
        return Stream.fromIterable([
          { _tag: "TextDelta", text: `answer-${index + 1}` } as StreamEvent,
          FINISH,
        ]);
      }
      return Stream.unwrap(
        Effect.promise(() => waitForReleaseOrAbort(request.abort)).pipe(
          Effect.map((outcome) => {
            if (outcome === "aborted") return Stream.empty;
            if (firstOutcome === "fail") {
              return Stream.fail(
                new AuthFailed({ message: "scripted provider failure" }),
              );
            }
            return Stream.fromIterable([
              { _tag: "TextDelta", text: "answer-1" } as StreamEvent,
              FINISH,
            ]);
          }),
        ),
      );
    },
  };

  return { adapter, calls, releaseFirst: release };
};

interface Fixture {
  readonly app: ServerApp;
  readonly workspace: string;
}

const makeFixture = async (
  provider: ProviderAdapter,
  configText = "",
): Promise<Fixture> => {
  const root = await Deno.makeTempDir({ prefix: "niuma_input_delivery_" });
  const workspace = join(root, "workspace");
  await Deno.mkdir(workspace, { recursive: true });
  const boot = await bootstrap({
    paths: {
      root,
      sessions: join(root, "sessions"),
      db: join(root, "niuma.db"),
    },
    config: parseConfig(configText),
    mcpConfig: {},
    infra: { provider },
  });
  return {
    app: await createServerApp({ bootstrap: boot }),
    workspace,
  };
};

const jsonRequest = (
  path: string,
  method: string,
  body?: unknown,
): Request =>
  new Request(`http://niuma.internal${path}`, {
    method,
    ...(body !== undefined
      ? {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }
      : {}),
  });

const createSession = async (
  app: ServerApp,
  workspace: string,
): Promise<{ sessionId: string; inputDelivery: string }> => {
  const response = await app.app.fetch(
    jsonRequest("/sessions", "POST", { workspace, model: "test-model" }),
  );
  assertEquals(response.status, 201);
  const body = await response.json();
  return {
    sessionId: body.sessionId as string,
    inputDelivery: body.clientConfig.inputDelivery as string,
  };
};

const submit = async (
  app: ServerApp,
  sessionId: string,
  text: string,
): Promise<string> => {
  const response = await app.app.fetch(
    jsonRequest(`/sessions/${sessionId}/prompt`, "POST", { text }),
  );
  assertEquals(response.status, 202);
  return (await response.json()).disposition as string;
};

const setDelivery = async (
  app: ServerApp,
  inputDelivery: "steer" | "queue",
): Promise<void> => {
  const response = await app.app.fetch(
    jsonRequest("/config/input-delivery", "PUT", { inputDelivery }),
  );
  assertEquals(response.status, 200);
  assertEquals((await response.json()).config.inputDelivery, inputDelivery);
};

interface HistoryEvent {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

const history = async (
  app: ServerApp,
  sessionId: string,
): Promise<HistoryEvent[]> => {
  const response = await app.app.fetch(
    new Request(`http://niuma.internal/sessions/${sessionId}/history`),
  );
  assertEquals(response.status, 200);
  return (await response.json()).events as HistoryEvent[];
};

const waitForCalls = async (
  provider: ControlledProvider,
  count: number,
): Promise<void> => {
  for (let i = 0; i < 100 && provider.calls.length < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assertEquals(
    provider.calls.length >= count,
    true,
    `provider received ${provider.calls.length}/${count} expected requests`,
  );
};

const userTexts = (events: ReadonlyArray<HistoryEvent>): string[] =>
  events
    .filter((event) => event.type === "user.message")
    .map((event) => {
      const sourceText = event.data.sourceText;
      if (typeof sourceText === "string") return sourceText;
      const parts = event.data.parts as Array<
        { type: string; text?: string }
      >;
      return parts.find((part) => part.type === "text")?.text ?? "";
    });

const observeRecovered = (
  app: ServerApp,
  sessionId: string,
): {
  readonly ready: Promise<void>;
  readonly event: Promise<SseEvent>;
} => {
  let ready!: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const event = Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const stream = yield* app.bootstrap.bus.subscribe(sessionId);
        yield* Effect.sync(ready);
        const found = yield* stream.pipe(
          Stream.filter((frame) => frame.event.type === "input.recovered"),
          Stream.runHead,
        );
        if (Option.isNone(found)) {
          return yield* Effect.die("event bus closed before input.recovered");
        }
        return found.value;
      }),
    ),
  );
  return { ready: readyPromise, event };
};

const appendRound = async (
  app: ServerApp,
  sessionId: string,
  index: number,
): Promise<void> => {
  await Effect.runPromise(app.kernel.append({
    type: "user.message",
    sessionId,
    data: { parts: [{ type: "text", text: `old question ${index}` }] },
  }));
  await Effect.runPromise(app.kernel.append({
    type: "assistant.message",
    sessionId,
    data: {
      parts: [{ type: "text", text: `old answer ${index}` }],
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  }));
};

Deno.test({
  name: "steered inputs remain unconsumed and return in order on interrupt",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const provider = controlledProvider();
    const { app, workspace } = await makeFixture(provider.adapter);
    try {
      const created = await createSession(app, workspace);
      assertEquals(created.inputDelivery, "steer");
      assertEquals(await submit(app, created.sessionId, "initial"), "started");
      await waitForCalls(provider, 1);

      assertEquals(
        await submit(app, created.sessionId, "steer one"),
        "steered",
      );
      assertEquals(
        await submit(app, created.sessionId, "steer two"),
        "steered",
      );

      const response = await app.app.fetch(
        jsonRequest(`/sessions/${created.sessionId}/interrupt`, "POST", {}),
      );
      assertEquals(response.status, 200);
      assertEquals((await response.json()).returnedInputs, [
        { sourceText: "steer one" },
        { sourceText: "steer two" },
      ]);

      const events = await history(app, created.sessionId);
      assertEquals(userTexts(events), ["initial"]);
      assertEquals(
        events.filter((event) => event.type === "turn.aborted").length,
        1,
      );
      assertEquals(provider.calls.length, 1);
    } finally {
      await app.close();
    }
  },
});

Deno.test({
  name: "queue inputs survive interrupt and automatically run as FIFO Turns",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const provider = controlledProvider();
    const { app, workspace } = await makeFixture(provider.adapter);
    try {
      const created = await createSession(app, workspace);
      await setDelivery(app, "queue");

      const session = await app.app.fetch(
        new Request(`http://niuma.internal/sessions/${created.sessionId}`),
      );
      assertEquals((await session.json()).clientConfig.inputDelivery, "queue");

      assertEquals(await submit(app, created.sessionId, "initial"), "started");
      await waitForCalls(provider, 1);
      assertEquals(
        await submit(app, created.sessionId, "queued one"),
        "queued",
      );
      assertEquals(
        await submit(app, created.sessionId, "queued two"),
        "queued",
      );

      const interrupted = await app.app.fetch(
        jsonRequest(`/sessions/${created.sessionId}/interrupt`, "POST", {}),
      );
      assertEquals((await interrupted.json()).returnedInputs, []);
      await Effect.runPromise(app.sessionManager.awaitAll());

      const events = await history(app, created.sessionId);
      assertEquals(userTexts(events), ["initial", "queued one", "queued two"]);
      assertEquals(
        events.filter((event) => event.type === "turn.started").length,
        3,
      );
      assertEquals(provider.calls.length, 3);
    } finally {
      await app.close();
    }
  },
});

Deno.test({
  name: "Turn failure recovers bound steers while FIFO input keeps running",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const provider = controlledProvider("fail");
    const { app, workspace } = await makeFixture(provider.adapter);
    try {
      const created = await createSession(app, workspace);
      assertEquals(await submit(app, created.sessionId, "initial"), "started");
      await waitForCalls(provider, 1);
      assertEquals(
        await submit(app, created.sessionId, "recover after failure"),
        "steered",
      );

      await setDelivery(app, "queue");
      assertEquals(
        await submit(app, created.sessionId, "continue from fifo"),
        "queued",
      );

      const recovered = observeRecovered(app, created.sessionId);
      await recovered.ready;
      provider.releaseFirst();
      const frame = await recovered.event;
      assertEquals(frame.event, {
        type: "input.recovered",
        ts: frame.event.ts,
        sessionId: created.sessionId,
        data: {
          reason: "turn_failed",
          inputs: [{ sourceText: "recover after failure" }],
        },
      });

      await Effect.runPromise(app.sessionManager.awaitAll());
      const events = await history(app, created.sessionId);
      assertEquals(userTexts(events), ["initial", "continue from fifo"]);
      assertEquals(
        events.some((event) =>
          event.type === "turn.completed" &&
          event.data.stopReason === "error"
        ),
        true,
      );
      assertEquals(provider.calls.length, 2);
    } finally {
      await app.close();
    }
  },
});

Deno.test({
  name: "prompts submitted during failed compaction queue and continue",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const provider = controlledProvider("fail");
    const { app, workspace } = await makeFixture(provider.adapter);
    try {
      const created = await createSession(app, workspace);
      for (let i = 1; i <= 3; i++) {
        await appendRound(app, created.sessionId, i);
      }

      const compact = await app.app.fetch(
        jsonRequest(`/sessions/${created.sessionId}/compact`, "POST", {}),
      );
      assertEquals(compact.status, 202);
      await waitForCalls(provider, 1);

      assertEquals(
        await submit(app, created.sessionId, "after compact one"),
        "queued",
      );
      assertEquals(
        await submit(app, created.sessionId, "after compact two"),
        "queued",
      );

      provider.releaseFirst();
      await Effect.runPromise(app.sessionManager.awaitAll());
      const events = await history(app, created.sessionId);
      assertEquals(userTexts(events).slice(-2), [
        "after compact one",
        "after compact two",
      ]);
      assertEquals(
        events.some((event) =>
          event.type === "compaction.performed" &&
          event.data.mode === "template"
        ),
        true,
      );
      assertEquals(provider.calls.length, 3);
    } finally {
      await app.close();
    }
  },
});
