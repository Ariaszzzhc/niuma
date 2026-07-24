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
    approval: {
      approvalId: "ap1",
      toolName: "bash",
      preview: [],
      selection: 0,
    },
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
    approval: {
      approvalId: "ap1",
      toolName: "bash",
      preview: [],
      selection: 0,
    },
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

// ---------------------------------------------------------------------------
// approval navigation (arrows / enter / digits)
// ---------------------------------------------------------------------------

const withApproval = (model: Model): Model => ({
  ...model,
  approval: { approvalId: "ap1", toolName: "bash", preview: [], selection: 0 },
});

Deno.test("approval nav: down/up move the selection, enter confirms it", () => {
  const program = newProgram();
  const update = program.update;
  let model = withApproval(program.init()[0]);

  model = update(model, keyMsg(key("down")))[0];
  assertEquals(model.approval?.selection, 1);
  model = update(model, keyMsg(key("down")))[0];
  assertEquals(model.approval?.selection, 2);
  // wrap-around past the last option
  model = update(model, keyMsg(key("down")))[0];
  assertEquals(model.approval?.selection, 0);
  model = update(model, keyMsg(key("up")))[0];
  assertEquals(model.approval?.selection, 2, "up from 0 wraps to the last");

  // enter confirms the highlighted option ("reject" at index 2) and dispatches
  const res = update(model, keyMsg(key("enter")));
  assertEquals(res[0].approval, null);
  assertEquals(res.length > 1, true, "the approve command was dispatched");
});

Deno.test("approval nav: digit 1 picks the first option directly", () => {
  const program = newProgram();
  const update = program.update;
  let model = withApproval(program.init()[0]);
  model = update(model, keyMsg(key("down")))[0]; // selection = 1
  const res = update(model, textMsg("1"));
  assertEquals(res[0].approval, null, "digit resolves the modal");
  assertEquals(res.length > 1, true);
});

// ---------------------------------------------------------------------------
// global page scroll (PgUp/PgDn + mouse wheel work from ANY focus)
// ---------------------------------------------------------------------------

const mouseMsg = (button: number): Msg =>
  keyMsg({
    kind: "mouse",
    button: button as never,
    eventType: "press",
    mods: noMods,
    x: 1,
    y: 1,
  });

Deno.test("page scroll: pageUp/pageDown scroll even while the editor is focused", () => {
  const program = newProgram();
  const u = step(program.update);
  let model = program.init()[0];
  model = fill(u, model);
  assertEquals(model.focus, "editor");
  assertEquals(model.followTail, true);

  // PgUp scrolls a full page and breaks follow WITHOUT moving focus.
  model = u(model, keyMsg(key("pageUp")));
  assertEquals(model.followTail, false, "pageUp breaks follow");
  assertEquals(model.focus, "editor", "focus stays in the editor");

  // PgDn back to the bottom re-engages follow.
  for (let i = 0; i < 10 && !model.followTail; i++) {
    model = u(model, keyMsg(key("pageDown")));
  }
  assertEquals(model.followTail, true, "pageDown back to bottom re-follows");
});

Deno.test("page scroll: mouse wheel scrolls from any focus, other buttons swallowed", () => {
  const program = newProgram();
  const u = step(program.update);
  let model = program.init()[0];
  model = fill(u, model);

  // wheel up breaks follow (and does not type into the editor)
  model = u(model, mouseMsg(64));
  assertEquals(model.followTail, false, "wheel up breaks follow");
  assertEquals(model.editor.lines, [""], "wheel never reaches the editor");

  // wheel back down to the bottom re-engages
  for (let i = 0; i < 20 && !model.followTail; i++) {
    model = u(model, mouseMsg(65));
  }
  assertEquals(model.followTail, true, "wheel down re-engages follow");

  // a left-button press is swallowed (no crash, no state change, no editor input)
  const before = model;
  model = u(model, mouseMsg(0));
  assertEquals(model, before);
});

// ---------------------------------------------------------------------------
// esc interrupt / ctrl+d quit
// ---------------------------------------------------------------------------

Deno.test("esc interrupts an active turn instead of resetting scroll", () => {
  const program = newProgram();
  const update = program.update;
  let model = program.init()[0];
  model = update(model, sse("turn.started"))[0];
  assertEquals(model.state.turnActive, true);

  const res = update(model, keyMsg({ kind: "esc" }));
  assertEquals(
    res.length > 1,
    true,
    "esc dispatched the interrupt command while a turn is active",
  );
  // followTail untouched (the esc-scroll-reset path was NOT taken)
  assertEquals(res[0].followTail, true);
});

Deno.test("esc without an active turn keeps the scroll-reset behavior", () => {
  const program = newProgram();
  const update = program.update;
  let model = program.init()[0];
  model = {
    ...model,
    followTail: false,
    transcriptScroll: 5,
    focus: "transcript",
  };
  const res = update(model, keyMsg({ kind: "esc" }));
  assertEquals(res.length, 1, "no command dispatched");
  assertEquals(res[0].followTail, true);
  assertEquals(res[0].focus, "editor");
});

Deno.test("ctrl+d with an empty editor quits on the second press", () => {
  const program = newProgram();
  const update = program.update;
  const model = program.init()[0];

  const first = update(model, textMsg("d", { ctrl: true }))[0];
  assertEquals(first.quitting, false, "first press only warns");
  assertEquals(
    first.state.notices.some((n) => n.text.includes("ctrl+d")),
    true,
    "the warning notice was posted",
  );

  const second = update(first, textMsg("d", { ctrl: true }))[0];
  assertEquals(second.quitting, true, "second press quits");
});

Deno.test("ctrl+d with text in the editor does not quit", () => {
  const program = newProgram();
  const update = program.update;
  let model = program.init()[0];
  model = {
    ...model,
    editor: { ...model.editor, lines: ["x"], cursor: { row: 0, col: 1 } },
  };
  const res = update(model, textMsg("d", { ctrl: true }));
  assertEquals(res[0].quitting, false);
  assertEquals(res[0].state.notices.length, 0, "no quit warning posted");
});
