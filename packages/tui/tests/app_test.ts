// ===========================================================================
// @niuma/tui — app-level reducer tests (buildProgram.update, no terminal)
// ---------------------------------------------------------------------------
// Drives the TEA program's `update` directly with synthetic key + SSE
// messages against a fake TuiClient (no network, no worker). Covers the two
// app.ts wiring fixes that are not reachable from the pure component tests:
//
//   - scroll / followTail: scrolling up breaks follow, and an incoming SSE
//     event while scrolled up does NOT re-pin the view to the tail (the old
//     code re-derived followTail from transcriptScroll===0 on every view and
//     routed scroll keys around transcriptReducer, so it could never scroll up
//     from the tail and any event snapped the view back).
//   - palette / approval priority: an approval modal takes input priority over
//     the palette (y/a/n reach the approval, not the palette query), and an
//     approval arriving while the palette is open closes it so view + input
//     agree.
//
// The native cdylib is touched (scroll computes content height via the
// markdown renderer -> stringWidth), so it is warmed at module load.
// ===========================================================================

import { assertEquals } from "@std/assert";
import type { InputEvent, KeyMods, NamedKey } from "@niuma/tuikit";
import { stringWidth } from "@niuma/tuikit";
import { buildProgram } from "../src/app.ts";
import type { ClientResult, TuiClient } from "../src/client.ts";
import { darkTheme } from "../src/theme.ts";

// Warm the native lib at module load (scroll path reaches stringWidth).
stringWidth("niuma");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Built = ReturnType<typeof buildProgram>;
type Model = ReturnType<Built["init"]>[0];
type Msg = Parameters<Built["update"]>[1];

const noMods: KeyMods = { shift: false, alt: false, ctrl: false, super: false };

const key = (k: NamedKey, mods: Partial<KeyMods> = {}): InputEvent => ({
  kind: "key",
  key: k,
  mods: { ...noMods, ...mods },
  eventType: "press",
});

const textEvent = (ch: string, mods: Partial<KeyMods> = {}): InputEvent => ({
  kind: "text",
  text: ch,
  mods: { ...noMods, ...mods },
  eventType: "press",
});

const keyMsg = (event: InputEvent): Msg => ({ type: "tuikit:key", event });
const textMsg = (ch: string, mods: Partial<KeyMods> = {}): Msg =>
  keyMsg(textEvent(ch, mods));
const sse = (type: string, data: Record<string, unknown> = {}): Msg => ({
  type: "tui:sse",
  event: { type, data },
});

const ok: ClientResult = { ok: true, status: 200, body: "" };

const fakeClient: TuiClient = {
  sessionId: "s1",
  contextWindow: 200_000,
  mcpServers: [],
  // Never consumed here (we drive update() directly, not the loop), but the
  // field is required; close immediately so nothing hangs if subscribed.
  eventsStream: new ReadableStream<Uint8Array>({
    start(c) {
      c.close();
    },
  }),
  prompt: () => Promise.resolve({ ok: true, status: 202, body: "" }),
  approve: () => Promise.resolve(ok),
  interrupt: () => Promise.resolve(ok),
};

const newProgram = (): Built =>
  buildProgram({
    client: fakeClient,
    theme: darkTheme,
    version: "test",
    workspace: "/w",
    // Tiny viewport so even a short transcript overflows it (banner 3 +
    // statusline 1 + editor 3 => transcriptH = rows - 7).
    size: { cols: 40, rows: 8 },
  });

/** `update` wrapper that yields just the next model (drops the cmd tail). */
const step = (update: Built["update"]) => (m: Model, msg: Msg): Model =>
  update(m, msg)[0];

/** Fill the transcript past the viewport with blank-separated paragraphs. */
const fill = (u: ReturnType<typeof step>, model: Model): Model => {
  model = u(model, sse("turn.started"));
  model = u(
    model,
    sse("assistant.message", {
      parts: [{ type: "text", text: "p1\n\np2\n\np3\n\np4\n\np5\n\np6\n\np7" }],
    }),
  );
  return model;
};

// ---------------------------------------------------------------------------
// scroll / followTail
// ---------------------------------------------------------------------------

Deno.test("app scroll: scrolling up breaks follow and survives an SSE event", () => {
  const program = newProgram();
  const u = step(program.update);
  let model = program.init()[0];

  model = fill(u, model);
  model = u(model, keyMsg(key("tab"))); // focus transcript
  assertEquals(model.focus, "transcript");
  assertEquals(model.followTail, true);

  // scroll up one row -> follow breaks, offset moves off the tail
  model = u(model, keyMsg(key("up")));
  assertEquals(model.followTail, false, "scroll up breaks follow");
  const offsetAfterScroll = model.transcriptScroll;

  // an incoming text.delta must NOT re-pin a scrolled-up view
  model = u(model, sse("text.delta", { delta: "more streaming text" }));
  assertEquals(
    model.followTail,
    false,
    "SSE event keeps the user's scroll position",
  );
  assertEquals(
    model.transcriptScroll,
    offsetAfterScroll,
    "offset unchanged by the SSE event",
  );
});

Deno.test("app scroll: end re-engages follow; home jumps to the top", () => {
  const program = newProgram();
  const u = step(program.update);
  let model = program.init()[0];
  model = fill(u, model);
  model = u(model, keyMsg(key("tab")));
  model = u(model, keyMsg(key("up")));
  assertEquals(model.followTail, false);

  model = u(model, keyMsg(key("end")));
  assertEquals(model.followTail, true, "end re-engages follow");

  model = u(model, keyMsg(key("up")));
  assertEquals(model.followTail, false);
  model = u(model, keyMsg(key("home")));
  assertEquals(model.followTail, false);
  assertEquals(model.transcriptScroll, 0);
});

Deno.test("app scroll: scrolling back down to the bottom re-engages follow", () => {
  const program = newProgram();
  const u = step(program.update);
  let model = program.init()[0];
  model = fill(u, model);
  model = u(model, keyMsg(key("tab")));
  model = u(model, keyMsg(key("up")));
  assertEquals(model.followTail, false);

  // page down repeatedly until we reach the bottom again
  for (let i = 0; i < 20; i++) {
    model = u(model, keyMsg(key("pageDown")));
    if (model.followTail) break;
  }
  assertEquals(
    model.followTail,
    true,
    "scrolling back to the bottom re-engages follow",
  );
});

// ---------------------------------------------------------------------------
// palette / approval input priority
// ---------------------------------------------------------------------------

Deno.test("app priority: an approval arriving while the palette is open closes it", () => {
  const program = newProgram();
  const u = step(program.update);
  let model = program.init()[0];

  // open the palette (ctrl+p)
  model = u(model, textMsg("p", { ctrl: true }));
  assertEquals(model.palette.open, true);

  // an approval.requested arrives
  model = u(
    model,
    sse("approval.requested", {
      approvalId: "ap1",
      callId: "c1",
      name: "bash",
      input: { command: "rm -rf /" },
    }),
  );
  assertEquals(
    model.palette.open,
    false,
    "palette closed so it cannot swallow the approval keys",
  );
  assertEquals(model.approval !== null, true);
});

Deno.test("app priority: y reaches the approval even when the palette is also open", () => {
  const program = newProgram();
  const update = program.update;
  let model = program.init()[0];

  // open the palette, then force the race the reorder defends against: an
  // approval present WHILE the palette is still open.
  model = update(model, textMsg("p", { ctrl: true }))[0];
  assertEquals(model.palette.open, true);
  model = {
    ...model,
    approval: { approvalId: "ap1", toolName: "bash", preview: [] },
  };

  const res = update(model, textMsg("y"));
  assertEquals(
    res[0].approval,
    null,
    "approval must win input priority over the palette",
  );
  assertEquals(res.length > 1, true, "the approve command was dispatched");
  assertEquals(
    res[0].palette.query,
    "",
    "the 'y' did not leak into the palette query",
  );
});

Deno.test("app priority: a non-decision key is swallowed while the approval modal is up", () => {
  const program = newProgram();
  const update = program.update;
  let model = program.init()[0];
  model = {
    ...model,
    approval: { approvalId: "ap1", toolName: "bash", preview: [] },
    // stash some editor text to prove a typed letter is NOT inserted
    editor: { ...model.editor, lines: ["x"], cursor: { row: 0, col: 1 } },
  };

  const res = update(model, textMsg("z"));
  // 'z' is not y/a/n -> swallowed, approval stays, editor untouched
  assertEquals(res[0].approval !== null, true);
  assertEquals(
    res[0].editor.lines,
    ["x"],
    "non-decision key did not reach the editor",
  );
});
