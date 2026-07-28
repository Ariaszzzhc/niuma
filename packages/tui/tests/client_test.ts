// ===========================================================================
// @niuma/tui — TuiClient session-switching tests (fake fetchImpl, no network)
// ---------------------------------------------------------------------------
// Drives `createTuiClient` against a scripted `fetch` that records every
// request and answers the five routes the client uses (POST /sessions,
// GET /events, GET /sessions[/ids], GET /sessions/:id, POST mutators). Covers
// the
// multi-session contract the /clear and /resume builtins rely on:
//
//   - boot creates the first session and opens its SSE stream at cursor 0
//     BEFORE any prompt;
//   - newSession() switches every accessor to the fresh session and bumps
//     streamVersion (the app's sseSub polls it to re-open the pump);
//   - resume() returns { info, history } and re-opens the stream strictly
//     AFTER the last recorded seq (server replays seq >= cursor);
//   - a failed resume leaves the current session + streamVersion untouched.
// ===========================================================================

import { assert, assertEquals, assertRejects } from "@std/assert";
import type { RecordedEvent, SessionInfo } from "@niuma/schema";
import { createTuiClient } from "../src/client.ts";

const BASE = "http://niuma.internal";

interface RecordedReq {
  readonly method: string;
  readonly url: string;
}

const sessionInfo = (sessionId: string): SessionInfo => ({
  sessionId,
  workspace: "/w",
  model: "default",
  createdAt: 1,
  updatedAt: 2,
  status: "idle",
});

const userMessage = (sessionId: string, seq: number): RecordedEvent => ({
  seq,
  ts: seq,
  sessionId,
  type: "user.message",
  data: {
    parts: [{ type: "text", text: `msg ${seq}` }],
    sourceText: `msg ${seq}`,
  },
});

const closedStream = (): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.close();
    },
  });

/** Scripted fetch: sequential session ids s1, s2, …; distinct (closed) stream
 * per /events call; `GET /sessions/s_old` answers with two history events. */
const fakeFetch = () => {
  const requests: RecordedReq[] = [];
  const sessionCreateBodies: unknown[] = [];
  let created = 0;
  const fetchImpl = ((
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ method, url });
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (method === "POST" && url === `${BASE}/sessions`) {
      sessionCreateBodies.push(JSON.parse(String(init?.body)));
      created += 1;
      return Promise.resolve(
        json(
          {
            sessionId: `s${created}`,
            workspace: "/w",
            model: "default",
            contextWindow: 100_000 + created,
            mcpServers: [{ id: "fs", toolCount: 3 }],
            commands: [{ name: "review" }],
            clientConfig: {
              inputDelivery: created === 1 ? "steer" : "queue",
            },
          },
          201,
        ),
      );
    }
    if (method === "GET" && url.startsWith(`${BASE}/events?`)) {
      return Promise.resolve(new Response(closedStream()));
    }
    if (method === "GET" && url === `${BASE}/sessions`) {
      return Promise.resolve(json([sessionInfo("s1"), sessionInfo("s_old")]));
    }
    if (method === "GET" && url === `${BASE}/sessions/ids`) {
      return Promise.resolve(json(["s1", "s_old"]));
    }
    if (method === "GET" && url === `${BASE}/sessions/s_old`) {
      return Promise.resolve(
        json({
          info: sessionInfo("s_old"),
          history: [userMessage("s_old", 2), userMessage("s_old", 7)],
          contextWindow: 77_000,
          mcpServers: [{ id: "old-fs", toolCount: 1 }],
          commands: [{ name: "old-review" }],
          clientConfig: { inputDelivery: "queue" },
        }),
      );
    }
    if (method === "GET" && url === `${BASE}/sessions/nope`) {
      return Promise.resolve(
        json({ error: { code: "session_not_found" } }, 404),
      );
    }
    if (method === "POST" && url === `${BASE}/sessions/s1/model`) {
      const body = JSON.parse(String(init?.body)) as { model?: string };
      if (body.model === "bad") {
        return Promise.resolve(
          json(
            { error: { code: "unknown_model", message: "unknown model: bad" } },
            400,
          ),
        );
      }
      return Promise.resolve(
        json({ ok: true, model: body.model, contextWindow: 256_000 }),
      );
    }
    if (method === "POST" && url === `${BASE}/sessions/s1/effort`) {
      const body = JSON.parse(String(init?.body)) as { effort?: string };
      return Promise.resolve(json({ ok: true, effort: body.effort }));
    }
    if (method === "POST" && url === `${BASE}/sessions/s1/compact`) {
      return Promise.resolve(json({ accepted: true }, 202));
    }
    if (method === "POST" && url === `${BASE}/sessions/s2/compact`) {
      return Promise.resolve(
        json(
          { error: { code: "turn_in_flight", message: "turn in flight" } },
          409,
        ),
      );
    }
    if (method === "POST" && url.endsWith("/prompt")) {
      return Promise.resolve(json({ disposition: "started" }, 202));
    }
    if (method === "POST" && url.endsWith("/interrupt")) {
      return Promise.resolve(
        json({ ok: true, returnedInputs: [{ sourceText: "restore me" }] }),
      );
    }
    if (method === "PUT" && url === `${BASE}/config/input-delivery`) {
      const body = JSON.parse(String(init?.body)) as {
        inputDelivery?: "steer" | "queue";
      };
      return Promise.resolve(
        json({
          ok: true,
          config: { inputDelivery: body.inputDelivery },
        }),
      );
    }
    if (method === "POST") return Promise.resolve(json({ ok: true }));
    return Promise.resolve(json({ error: { code: "not_found" } }, 404));
  }) as typeof fetch;
  return { fetchImpl, requests, sessionCreateBodies };
};

Deno.test("boot creates the first session and opens its stream first", async () => {
  const { fetchImpl, requests, sessionCreateBodies } = fakeFetch();
  const client = await createTuiClient(fetchImpl, { workspace: "/w" });

  assertEquals(client.sessionId, "s1");
  assertEquals(client.contextWindow, 100_001);
  assertEquals(client.mcpServers, [{ id: "fs", toolCount: 3 }]);
  assertEquals(client.commands, [{ name: "review" }]);
  assertEquals(client.inputDelivery, "steer");
  assertEquals(client.streamVersion, 0);
  assert(client.eventsStream instanceof ReadableStream);

  // Ordering: session create, then the SSE open at cursor 0 — before prompts.
  assertEquals(requests[0], { method: "POST", url: `${BASE}/sessions` });
  assertEquals(sessionCreateBodies, [{}]);
  assertEquals(
    requests[1],
    { method: "GET", url: `${BASE}/events?session=s1&cursor=0` },
  );

  const res = await client.prompt("hello");
  assertEquals(res, { ok: true, status: 202, disposition: "started" });
  assertEquals(requests.at(-1), {
    method: "POST",
    url: `${BASE}/sessions/s1/prompt`,
  });
});

Deno.test("newSession switches the accessors and bumps streamVersion", async () => {
  const { fetchImpl, requests } = fakeFetch();
  const client = await createTuiClient(fetchImpl, { workspace: "/w" });
  const firstStream = client.eventsStream;

  await client.newSession();

  assertEquals(client.sessionId, "s2");
  assertEquals(client.contextWindow, 100_002);
  assertEquals(client.inputDelivery, "queue");
  assertEquals(client.streamVersion, 1);
  assert(
    client.eventsStream !== firstStream,
    "eventsStream must be replaced on switch",
  );
  assertEquals(requests.at(-1), {
    method: "GET",
    url: `${BASE}/events?session=s2&cursor=0`,
  });

  // Mutators now target the new session.
  await client.prompt("again");
  assertEquals(await client.interrupt(), {
    ok: true,
    status: 200,
    returnedInputs: [{ sourceText: "restore me" }],
  });
  await client.approve("ap_1", "once");
  assertEquals(requests.at(-3), {
    method: "POST",
    url: `${BASE}/sessions/s2/prompt`,
  });
  assertEquals(requests.at(-2), {
    method: "POST",
    url: `${BASE}/sessions/s2/interrupt`,
  });
  assertEquals(requests.at(-1), {
    method: "POST",
    url: `${BASE}/sessions/s2/approvals/ap_1`,
  });
});

Deno.test("listSessions returns recent folded Session State", async () => {
  const { fetchImpl } = fakeFetch();
  const client = await createTuiClient(fetchImpl, { workspace: "/w" });

  const list = await client.listSessions();
  assertEquals(list, [sessionInfo("s1"), sessionInfo("s_old")]);
});

Deno.test("listSessionIds reads filename-only ids", async () => {
  const { fetchImpl, requests } = fakeFetch();
  const client = await createTuiClient(fetchImpl, { workspace: "/w" });

  assertEquals(await client.listSessionIds(), ["s1", "s_old"]);
  assertEquals(requests.at(-1), {
    method: "GET",
    url: `${BASE}/sessions/ids`,
  });
});

Deno.test("explicit initial resume opens exactly that Session at cursor 0", async () => {
  const { fetchImpl, requests, sessionCreateBodies } = fakeFetch();
  const client = await createTuiClient(fetchImpl, {
    workspace: "/w",
    resume: "s_old",
  });

  assertEquals(client.sessionId, "s_old");
  assertEquals(client.contextWindow, 77_000);
  assertEquals(sessionCreateBodies, []);
  assertEquals(requests.slice(0, 2), [
    { method: "GET", url: `${BASE}/sessions/s_old` },
    {
      method: "GET",
      url: `${BASE}/events?session=s_old&cursor=0`,
    },
  ]);
});

Deno.test("resume returns info+history and re-opens the stream after the last seq", async () => {
  const { fetchImpl, requests } = fakeFetch();
  const client = await createTuiClient(fetchImpl, { workspace: "/w" });

  const { info, history } = await client.resume("s_old");

  assertEquals(info, sessionInfo("s_old"));
  assertEquals(history.length, 2);
  assertEquals(client.sessionId, "s_old");
  assertEquals(client.streamVersion, 1);
  assertEquals(client.contextWindow, 77_000);
  assertEquals(client.mcpServers, [{ id: "old-fs", toolCount: 1 }]);
  assertEquals(client.commands, [{ name: "old-review" }]);
  assertEquals(client.inputDelivery, "queue");
  // max(seq) = 7, server replays seq >= cursor => stream opens at cursor 8.
  assertEquals(requests.at(-1), {
    method: "GET",
    url: `${BASE}/events?session=s_old&cursor=8`,
  });

  await client.prompt("continued");
  assertEquals(requests.at(-1), {
    method: "POST",
    url: `${BASE}/sessions/s_old/prompt`,
  });
});

Deno.test("a failed resume leaves session and streamVersion untouched", async () => {
  const { fetchImpl } = fakeFetch();
  const client = await createTuiClient(fetchImpl, { workspace: "/w" });

  await assertRejects(() => client.resume("nope"), Error, "404");

  assertEquals(client.sessionId, "s1");
  assertEquals(client.streamVersion, 0);
});

Deno.test("session creation rejects success payloads missing required metadata", async () => {
  const { fetchImpl: baseFetch } = fakeFetch();
  for (
    const body of [
      {
        sessionId: "bad",
        workspace: "/w",
        model: "default",
        commands: [],
      },
      {
        sessionId: "bad",
        workspace: "/w",
        model: "default",
        mcpServers: [],
      },
      {
        sessionId: "bad",
        workspace: "/w",
        model: "default",
        mcpServers: [],
        commands: [],
      },
    ]
  ) {
    const malformedFetch = ((
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      if (
        (init?.method ?? "GET") === "POST" &&
        String(input) === `${BASE}/sessions`
      ) {
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return baseFetch(input, init);
    }) as typeof fetch;
    await assertRejects(
      () => createTuiClient(malformedFetch, { workspace: "/w" }),
      Error,
      "session create error",
    );
  }
});

// ---------------------------------------------------------------------------
// Built-in command endpoints (model / effort / compact)
// ---------------------------------------------------------------------------

Deno.test("setModel posts to the current session and syncs contextWindow", async () => {
  const { fetchImpl, requests } = fakeFetch();
  const client = await createTuiClient(fetchImpl, { workspace: "/w" });

  const r = await client.setModel("m2");
  assertEquals(r, { ok: true, model: "m2", contextWindow: 256_000 });
  assertEquals(
    client.contextWindow,
    256_000,
    "the getter reflects the new model's window",
  );
  assertEquals(requests.at(-1), {
    method: "POST",
    url: `${BASE}/sessions/s1/model`,
  });
});

Deno.test("setModel surfaces the server error message", async () => {
  const { fetchImpl } = fakeFetch();
  const client = await createTuiClient(fetchImpl, { workspace: "/w" });

  const r = await client.setModel("bad");
  assertEquals(r.ok, false);
  assertEquals(r.code, "unknown_model");
  assertEquals(r.error, "unknown model: bad");
  assertEquals(
    client.contextWindow,
    100_001,
    "contextWindow untouched on failure",
  );
});

Deno.test("setEffort posts the effort verbatim", async () => {
  const { fetchImpl, requests } = fakeFetch();
  const client = await createTuiClient(fetchImpl, { workspace: "/w" });

  const r = await client.setEffort("high");
  assertEquals(r, { ok: true, effort: "high" });
  assertEquals(requests.at(-1), {
    method: "POST",
    url: `${BASE}/sessions/s1/effort`,
  });
});

Deno.test("setInputDelivery updates the server-owned client config view", async () => {
  const { fetchImpl, requests } = fakeFetch();
  const client = await createTuiClient(fetchImpl, { workspace: "/w" });

  assertEquals(client.inputDelivery, "steer");
  assertEquals(await client.setInputDelivery("queue"), {
    ok: true,
    inputDelivery: "queue",
  });
  assertEquals(client.inputDelivery, "queue");
  assertEquals(requests.at(-1), {
    method: "PUT",
    url: `${BASE}/config/input-delivery`,
  });
});

Deno.test("model and effort reject malformed success payloads", async () => {
  const { fetchImpl: baseFetch } = fakeFetch();
  const malformedFetch = ((
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    if (
      (init?.method ?? "GET") === "POST" &&
      (url.endsWith("/model") || url.endsWith("/effort"))
    ) {
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return baseFetch(input, init);
  }) as typeof fetch;
  const client = await createTuiClient(malformedFetch, { workspace: "/w" });

  const model = await client.setModel("m2");
  assertEquals(model.ok, false);
  assert(model.error !== undefined);
  assertEquals(client.contextWindow, 100_001);

  const effort = await client.setEffort("high");
  assertEquals(effort.ok, false);
  assert(effort.error !== undefined);
});

Deno.test("prompt, interrupt, and delivery reject malformed success payloads", async () => {
  const { fetchImpl: baseFetch } = fakeFetch();
  const malformedFetch = ((
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "POST" && url.endsWith("/prompt")) {
      return Promise.resolve(
        new Response(JSON.stringify({ accepted: true }), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (method === "POST" && url.endsWith("/interrupt")) {
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, returnedInputs: ["bad"] }), {
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (method === "PUT" && url.endsWith("/config/input-delivery")) {
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, config: {} }), {
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return baseFetch(input, init);
  }) as typeof fetch;
  const client = await createTuiClient(malformedFetch, { workspace: "/w" });

  const prompt = await client.prompt("hello");
  assertEquals(prompt.ok, false);
  assert(prompt.error !== undefined);

  const interrupt = await client.interrupt();
  assertEquals(interrupt.ok, false);
  assertEquals(interrupt.returnedInputs, []);
  assert(interrupt.error !== undefined);

  const delivery = await client.setInputDelivery("queue");
  assertEquals(delivery.ok, false);
  assert(delivery.error !== undefined);
  assertEquals(client.inputDelivery, "steer");
});

Deno.test("compact reports accepted, then turn_in_flight on the busy session", async () => {
  const { fetchImpl } = fakeFetch();
  const client = await createTuiClient(fetchImpl, { workspace: "/w" });

  assertEquals(await client.compact(), { ok: true });

  await client.newSession(); // switch to s2, whose compact is rejected
  const r = await client.compact();
  assertEquals(r.ok, false);
  assertEquals(r.code, "turn_in_flight");
  assertEquals(r.error, "turn in flight");
});
