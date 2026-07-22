import {
  assertEquals,
  assertExists,
  assertRejects,
} from "jsr:@std/assert@^1.0.0";
import { join } from "@std/path";
import { type RecordedEvent } from "@niuma/schema";
import {
  ensureDataDirSync,
  EventLog,
  Projection,
} from "@niuma/store";

async function tmpDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "niuma-store-" });
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

async function writeJsonl(path: string, lines: string[]) {
  await Deno.writeTextFile(path, lines.join("\n") + "\n");
}

Deno.test("EventLog create assigns monotonic seq from 1", async () => {
  const dir = await tmpDir();
  try {
    const sid = "sess-A";
    const log = EventLog.create(sid, { workspace: dir, model: "m" }, dir);
    assertEquals(log.lastSeq, 1);

    const e2 = log.append({
      ts: Date.now(),
      sessionId: sid,
      type: "user.message",
      data: { parts: [{ type: "text", text: "hi" }] },
    });
    assertEquals(e2.seq, 2);

    log.close();

    const events = await collect(EventLog.replay(sid, dir));
    assertEquals(events.length, 2);
    assertEquals(events[0].type, "session.created");
    assertEquals(events[1].type, "user.message");
    assertEquals(events.map((e) => e.seq), [1, 2]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("EventLog reopen preserves lastSeq", async () => {
  const dir = await tmpDir();
  try {
    const sid = "sess-B";
    const log1 = EventLog.create(sid, { workspace: dir, model: "m" }, dir);
    log1.append({
      ts: Date.now(),
      sessionId: sid,
      type: "user.message",
      data: { parts: [{ type: "text", text: "first" }] },
    });
    log1.flush();
    log1.close();

    const log2 = EventLog.open(sid, dir);
    assertEquals(log2.lastSeq, 2);
    const next = log2.append({
      ts: Date.now(),
      sessionId: sid,
      type: "turn.started",
      data: {},
    });
    assertEquals(next.seq, 3);
    log2.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("replay tolerates truncated last line", async () => {
  const dir = await tmpDir();
  try {
    const sid = "sess-trunc";
    await Deno.mkdir(join(dir, "sessions"), { recursive: true });
    const good = JSON.stringify({
      seq: 1,
      ts: 1,
      sessionId: sid,
      type: "session.created",
      data: { workspace: dir, model: "m" },
    });
    const filePath = join(dir, "sessions", `${sid}.jsonl`);
    // Write good line terminated with "\n", then a partial line with NO
    // trailing newline — this is the crash signature we tolerate.
    await Deno.writeTextFile(filePath, `${good}\n${good.slice(0, good.length - 5)}`);

    const events = await collect(EventLog.replay(sid, dir));
    assertEquals(events.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("EventLog.open repairs truncated last line before append", async () => {
  const dir = await tmpDir();
  try {
    const sid = "sess-trunc-reopen";
    await Deno.mkdir(join(dir, "sessions"), { recursive: true });
    const good = JSON.stringify({
      seq: 1,
      ts: 1,
      sessionId: sid,
      type: "session.created",
      data: { workspace: dir, model: "m" },
    });
    const filePath = join(dir, "sessions", `${sid}.jsonl`);
    // Write good line terminated with "\n", then a partial line with NO
    // trailing newline — the crash signature. Re-opening for append must
    // discard the partial bytes before the next write lands.
    await Deno.writeTextFile(
      filePath,
      `${good}\n${good.slice(0, good.length - 5)}`,
    );

    const log = EventLog.open(sid, dir);
    assertEquals(log.lastSeq, 1);
    const e2 = log.append({
      ts: 2,
      sessionId: sid,
      type: "turn.started",
      data: {},
    });
    assertEquals(e2.seq, 2);
    log.flush();
    log.close();

    const events = await collect(EventLog.replay(sid, dir));
    assertEquals(events.length, 2);
    assertEquals(events[0].type, "session.created");
    assertEquals(events[1].type, "turn.started");
    assertEquals(events.map((e) => e.seq), [1, 2]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("replay throws on corrupt middle line", async () => {
  const dir = await tmpDir();
  try {
    const sid = "sess-corrupt";
    await Deno.mkdir(join(dir, "sessions"), { recursive: true });
    const good = JSON.stringify({
      seq: 1,
      ts: 1,
      sessionId: sid,
      type: "session.created",
      data: { workspace: dir, model: "m" },
    });
    const good2 = JSON.stringify({
      seq: 3,
      ts: 3,
      sessionId: sid,
      type: "turn.started",
      data: {},
    });
    const filePath = join(dir, "sessions", `${sid}.jsonl`);
    await writeJsonl(filePath, [good, "this is not JSON", good2]);

    await assertRejects(async () => {
      for await (const _ of EventLog.replay(sid, dir)) {
        // consume
      }
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Projection tracks session lifecycle", async () => {
  const dir = await tmpDir();
  try {
    const proj = Projection.open(dir);
    await proj.migrate();
    const sid = "sess-proj";

    const events: RecordedEvent[] = [
      {
        seq: 1,
        ts: 1,
        sessionId: sid,
        type: "session.created",
        data: { workspace: dir, model: "m" },
      },
      {
        seq: 2,
        ts: 2,
        sessionId: sid,
        type: "turn.started",
        data: {},
      },
      {
        seq: 3,
        ts: 3,
        sessionId: sid,
        type: "user.message",
        data: { parts: [{ type: "text", text: "fix the bug" }] },
      },
      {
        seq: 4,
        ts: 4,
        sessionId: sid,
        type: "turn.completed",
        data: { stopReason: "stop", usage: { inputTokens: 5, outputTokens: 7 } },
      },
    ];

    await Deno.mkdir(join(dir, "sessions"), { recursive: true });
    const filePath = join(dir, "sessions", `${sid}.jsonl`);
    await writeJsonl(filePath, events.map((e) => JSON.stringify(e)));

    for (const ev of events) await proj.apply(ev);

    const info = await proj.getSession(sid);
    assertExists(info);
    assertEquals(info!.sessionId, sid);
    assertEquals(info!.model, "m");
    assertEquals(info!.lastStopReason, "stop");
    assertEquals(info!.messageCount, 1);
    assertEquals(info!.title, "fix the bug");
    await proj.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Projection title is first-user-wins, not last", async () => {
  const dir = await tmpDir();
  try {
    const proj = Projection.open(dir);
    await proj.migrate();
    const sid = "sess-title";

    const events: RecordedEvent[] = [
      {
        seq: 1,
        ts: 1,
        sessionId: sid,
        type: "session.created",
        data: { workspace: dir, model: "m" },
      },
      {
        seq: 2,
        ts: 2,
        sessionId: sid,
        type: "user.message",
        data: { parts: [{ type: "text", text: "first prompt" }] },
      },
      {
        seq: 3,
        ts: 3,
        sessionId: sid,
        type: "user.message",
        data: { parts: [{ type: "text", text: "second prompt" }] },
      },
    ];

    for (const ev of events) await proj.apply(ev);

    const info = await proj.getSession(sid);
    assertExists(info);
    assertEquals(info!.title, "first prompt");
    await proj.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Projection rebuildAll replays JSONL", async () => {
  const dir = await tmpDir();
  try {
    const proj = Projection.open(dir);
    await proj.migrate();
    const sid = "sess-rebuild";

    const events: RecordedEvent[] = [
      {
        seq: 1,
        ts: 1,
        sessionId: sid,
        type: "session.created",
        data: { workspace: dir, model: "gpt-x" },
      },
      {
        seq: 2,
        ts: 2,
        sessionId: sid,
        type: "user.message",
        data: { parts: [{ type: "text", text: "yo" }] },
      },
    ];

    await Deno.mkdir(join(dir, "sessions"), { recursive: true });
    await writeJsonl(
      join(dir, "sessions", `${sid}.jsonl`),
      events.map((e) => JSON.stringify(e)),
    );

    await proj.rebuildAll();

    const info = await proj.getSession(sid);
    assertExists(info);
    assertEquals(info!.model, "gpt-x");
    assertEquals(info!.messageCount, 1);
    await proj.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("EventLog listSessionFiles enumerates session ids", async () => {
  const dir = await tmpDir();
  try {
    EventLog.create("alpha", { workspace: dir, model: "m" }, dir).close();
    EventLog.create("beta", { workspace: dir, model: "m" }, dir).close();
    EventLog.create("gamma", { workspace: dir, model: "m" }, dir).close();
    const ids = EventLog.listSessionFiles(dir);
    assertEquals(ids, ["alpha", "beta", "gamma"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ensureDataDirSync creates sessions/ and output/", async () => {
  const dir = await tmpDir();
  try {
    ensureDataDirSync(dir);
    const stat1 = Deno.statSync(join(dir, "sessions"));
    assertEquals(stat1.isDirectory, true);
    const stat2 = Deno.statSync(join(dir, "output"));
    assertEquals(stat2.isDirectory, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
