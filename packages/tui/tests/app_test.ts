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

import { assert, assertEquals } from "@std/assert";
import type { InputEvent, KeyMods, NamedKey } from "@niuma/tuikit";
import { stringWidth } from "@niuma/tuikit";
import type { RecordedEvent, SessionInfo } from "@niuma/schema";
import { buildProgram } from "../src/app.ts";
import type { ClientResult, TuiClient } from "../src/client.ts";
import type { SseEvent } from "../src/reduce_event.ts";
import {
  darkTheme,
  fullColorCaps,
  pickTheme,
  type Theme,
} from "../src/theme.ts";

const lightTheme = pickTheme("light", fullColorCaps);

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
  event: { type, data } as unknown as SseEvent,
});

const ok: ClientResult = { ok: true, status: 200, body: "" };

const fakeClient: TuiClient = {
  sessionId: "s1",
  contextWindow: 200_000,
  mcpServers: [],
  commands: [],
  inputDelivery: "steer",
  // Never consumed here (we drive update() directly, not the loop), but the
  // field is required; close immediately so nothing hangs if subscribed.
  eventsStream: new ReadableStream<Uint8Array>({
    start(c) {
      c.close();
    },
  }),
  streamVersion: 0,
  prompt: () =>
    Promise.resolve({ ok: true, status: 202, disposition: "started" }),
  approve: () => Promise.resolve(ok),
  interrupt: () =>
    Promise.resolve({ ok: true, status: 200, returnedInputs: [] }),
  newSession: () => Promise.resolve(),
  listSessions: () => Promise.resolve([]),
  listSessionIds: () => Promise.resolve([]),
  resume: () =>
    Promise.reject(new Error("fake client: resume not implemented")),
  setModel: () => Promise.resolve({ ok: true }),
  setEffort: () => Promise.resolve({ ok: true }),
  renameTitle: () => Promise.resolve({ ok: true }),
  setInputDelivery: (inputDelivery) =>
    Promise.resolve({ ok: true, inputDelivery }),
  compact: () => Promise.resolve({ ok: true }),
  subagentHistory: () => Promise.resolve([]),
  openSubagentStream: () =>
    Promise.resolve(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.close();
        },
      }),
    ),
};

const newProgram = (): Built =>
  buildProgram({
    client: fakeClient,
    theme: darkTheme,
    version: "test",
    workspace: "/w",
    // Tiny viewport so even a short transcript overflows it (banner 3 +
    // footer 2 + editor 3 leaves a short transcript viewport).
    size: { cols: 40, rows: 8 },
  });

const sizedProgram = (
  cols: number,
  rows: number,
  theme: Theme = darkTheme,
): Built =>
  buildProgram({
    client: fakeClient,
    theme,
    version: "test",
    workspace: "/workspace/测试-niuma",
    size: { cols, rows },
  });

const assertViewFits = (
  program: Built,
  model: Model,
  cols: number,
  rows: number,
): void => {
  const view = program.view(model);
  assertEquals(view.lines.length, rows, "view fills terminal height");
  for (const line of view.lines) {
    const width = line.spans.reduce(
      (sum, span) => sum + stringWidth(span.text),
      0,
    );
    assert(width <= cols, `row width ${width} must fit ${cols}`);
  }
  if (view.cursor !== undefined) {
    assert(view.cursor.row >= 0 && view.cursor.row < rows);
    assert(view.cursor.col >= 0 && view.cursor.col < cols);
  }
};

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

Deno.test("app surfaces approval and interrupt response details", () => {
  const program = newProgram();
  const u = step(program.update);
  let model = program.init()[0];

  model = u(model, {
    type: "tui:approval",
    ok: false,
    status: 409,
    body: "approval expired",
  });
  model = u(model, {
    type: "tui:interrupt",
    ok: false,
    status: 503,
    returnedInputs: [],
    error: "runtime unavailable",
  });

  assertEquals(
    model.state.notices.slice(-2).map((notice) => notice.text),
    [
      "approval failed (409) approval expired",
      "interrupt failed (503) runtime unavailable",
    ],
  );
});

// ---------------------------------------------------------------------------
// scroll / followTail
// ---------------------------------------------------------------------------

Deno.test("app layout: welcome/editor/footer fit target sizes in dark and light themes", () => {
  const sizes = [
    [24, 20],
    [30, 20],
    [40, 20],
    [80, 24],
    [120, 40],
  ] as const;
  for (const theme of [darkTheme, lightTheme]) {
    for (const [cols, rows] of sizes) {
      const program = sizedProgram(cols, rows, theme);
      const model = program.init()[0];
      assertViewFits(program, model, cols, rows);
      const output = program.view(model).lines
        .map((line) => line.spans.map((span) => span.text).join(""))
        .join("\n");
      assert(
        output.includes("niuma"),
        `${cols}x${rows} welcome shows identity`,
      );
    }
  }
});

Deno.test("app layout: CJK editor, palette, approval and question surfaces fit 40x20", () => {
  const program = sizedProgram(40, 20);
  const u = step(program.update);

  let editorModel = program.init()[0];
  editorModel = u(
    editorModel,
    textMsg("请分析这个很长的项目路径并保留emoji👨‍👩‍👧以及输入法光标"),
  );
  assertViewFits(program, editorModel, 40, 20);

  let paletteModel = program.init()[0];
  paletteModel = u(paletteModel, textMsg("p", { ctrl: true }));
  assertEquals(paletteModel.palette.open, true);
  assertViewFits(program, paletteModel, 40, 20);

  let approvalModel = program.init()[0];
  approvalModel = u(
    approvalModel,
    sse("approval.requested", {
      approvalId: "fit-approval",
      callId: "fit-call",
      name: "bash",
      input: { command: "echo 一个很长的命令用于审批预览" },
    }),
  );
  assertViewFits(program, approvalModel, 40, 20);

  let questionModel = program.init()[0];
  questionModel = u(
    questionModel,
    sse("approval.requested", {
      approvalId: "fit-question",
      callId: "fit-question-call",
      name: "question",
      input: {
        question: "请选择接下来要采用的实现路径？",
        options: ["保持现状", "采用新布局", "先做一个原型再决定"],
      },
    }),
  );
  assertViewFits(program, questionModel, 40, 20);
});

Deno.test("app layout: resize recomputes wrapping and hardware cursor bounds", () => {
  const program = sizedProgram(80, 24);
  const u = step(program.update);
  let model = program.init()[0];
  for (const ch of "a long line ".repeat(12)) model = u(model, textMsg(ch));
  model = u(model, {
    type: "tuikit:resize",
    size: { cols: 30, rows: 20 },
  } as Msg);
  assertViewFits(program, model, 30, 20);
});

Deno.test("app scroll: scrolling up breaks follow and survives an SSE event", () => {
  const program = newProgram();
  const u = step(program.update);
  let model = program.init()[0];

  model = fill(u, model);
  assertEquals(model.followTail, true);

  // page up -> follow breaks, offset moves off the tail
  model = u(model, keyMsg(key("pageUp")));
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

Deno.test("app transcript: finalizing streaming text preserves tool-call order", () => {
  const program = buildProgram({
    client: fakeClient,
    theme: darkTheme,
    version: "test",
    workspace: "/w",
    size: { cols: 100, rows: 24 },
  });
  const u = step(program.update);
  let model = program.init()[0];

  const assertOrder = (label: string): void => {
    const text = program.view(model).lines
      .map((line) => line.spans.map((span) => span.text).join(""))
      .join("\n");
    const before = text.indexOf("BEFORE_TOOL");
    const tool = text.indexOf("ORDER_PROBE");
    const after = text.indexOf("AFTER_TOOL");
    assert(before >= 0, `${label}: missing text before tool`);
    assert(tool >= 0, `${label}: missing tool call`);
    assert(after >= 0, `${label}: missing text after tool`);
    assert(
      before < tool && tool < after,
      `${label}: expected before < tool < after`,
    );
  };

  model = u(model, sse("text.delta", { delta: "BEFORE_TOOL" }));
  model = u(
    model,
    sse("assistant.message", {
      parts: [],
    }),
  );
  model = u(
    model,
    sse("tool.call.requested", {
      callId: "order-probe",
      name: "ORDER_PROBE",
      input: {},
    }),
  );
  model = u(
    model,
    sse("tool.result", {
      callId: "order-probe",
      content: "",
      isError: false,
      durationMs: 1,
    }),
  );
  model = u(model, sse("text.delta", { delta: "AFTER_TOOL" }));
  assertOrder("while streaming");

  model = u(
    model,
    sse("assistant.message", {
      parts: [],
    }),
  );
  assertOrder("after assistant.message");

  model = u(model, sse("turn.completed", { stopReason: "stop" }));
  assertOrder("after turn.completed");
});

Deno.test("app scroll: line keys stay in the editor (they never scroll the transcript)", () => {
  const program = newProgram();
  const u = step(program.update);
  let model = program.init()[0];
  model = fill(u, model);

  // up/down/home/end are editor input (history recall / caret moves); the
  // transcript only scrolls via PgUp/PgDn and the mouse wheel.
  for (const k of ["up", "down", "home", "end"] as const) {
    const before = model;
    model = u(model, keyMsg(key(k)));
    assertEquals(model.followTail, true, `${k} does not break follow`);
    assertEquals(
      model.transcriptScroll,
      before.transcriptScroll,
      `${k} does not scroll the transcript`,
    );
  }
});

Deno.test("app scroll: scrolling back down to the bottom re-engages follow", () => {
  const program = newProgram();
  const u = step(program.update);
  let model = program.init()[0];
  model = fill(u, model);
  model = u(model, keyMsg(key("pageUp")));
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

Deno.test("question tool uses a separate bottom editor and preserves the main draft", () => {
  const program = newProgram();
  const u = step(program.update);
  let model = program.init()[0];

  for (const ch of "main draft") model = u(model, textMsg(ch));
  const draft = model.editor.lines.join("\n");

  model = u(
    model,
    sse("approval.requested", {
      approvalId: "q1",
      callId: "call-q1",
      name: "question",
      input: {
        question: "Which path?",
        options: ["Current", "New"],
      },
    }),
  );
  assertEquals(model.question?.question, "Which path?");
  assertEquals(model.approval, null);
  assertEquals(model.editor.lines.join("\n"), draft);

  for (const ch of "Custom") model = u(model, textMsg(ch));
  assertEquals(model.question?.answer.lines.join("\n"), "Custom");
  assertEquals(model.editor.lines.join("\n"), draft);

  const viewText = program.view(model).lines
    .map((line) => line.spans.map((span) => span.text).join(""))
    .join("\n");
  assert(viewText.includes("Which path?"));

  model = u(model, keyMsg(key("enter")));
  assertEquals(model.question, null);
  assertEquals(model.editor.lines.join("\n"), draft);
});

Deno.test("malformed question input falls back to approval", () => {
  const program = newProgram();
  const u = step(program.update);
  let model = program.init()[0];
  model = u(
    model,
    sse("approval.requested", {
      approvalId: "q2",
      callId: "call-q2",
      name: "question",
      input: "legacy question payload",
    }),
  );
  assertEquals(model.question, null);
  assertEquals(model.approval?.toolName, "question");
});

Deno.test("ctrl+o toggles recent-turn detail mode without mutating tool data", () => {
  const program = newProgram();
  const u = step(program.update);
  let model = program.init()[0];
  model = u(
    model,
    sse("tool.call.requested", {
      callId: "detail-call",
      name: "bash",
      input: { command: "echo hello" },
    }),
  );
  const before = model.state.toolCalls;
  model = u(model, textMsg("o", { ctrl: true }));
  assertEquals(model.detailsExpanded, true);
  assertEquals(model.state.toolCalls, before);
  model = u(model, textMsg("o", { ctrl: true }));
  assertEquals(model.detailsExpanded, false);
});

Deno.test("ctrl+o expands details for only the most recent three turns", () => {
  const program = sizedProgram(60, 200);
  const u = step(program.update);
  let model = program.init()[0];
  for (let turn = 1; turn <= 4; turn++) {
    model = u(
      model,
      sse("user.message", {
        parts: [{ type: "text", text: `question ${turn}` }],
      }),
    );
    model = u(
      model,
      sse("assistant.message", {
        parts: [
          {
            type: "thinking",
            text: `${
              Array.from({ length: 50 }, (_, i) => `t${turn}-${i}`).join(" ")
            } TURN${turn}_TAIL`,
          },
          { type: "text", text: `answer ${turn}` },
        ],
      }),
    );
  }
  model = u(model, textMsg("o", { ctrl: true }));
  const output = program.view(model).lines
    .map((line) => line.spans.map((span) => span.text).join(""))
    .join("\n");
  assertEquals(output.includes("TURN1_TAIL"), false);
  for (const turn of [2, 3, 4]) {
    assert(
      output.includes(`TURN${turn}_TAIL`),
      `turn ${turn} is within the expanded recent window`,
    );
  }
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

Deno.test("page scroll: pageUp/pageDown scroll while the user is typing", () => {
  const program = newProgram();
  const u = step(program.update);
  let model = program.init()[0];
  model = fill(u, model);
  assertEquals(model.followTail, true);

  // PgUp scrolls a full page and breaks follow.
  model = u(model, keyMsg(key("pageUp")));
  assertEquals(model.followTail, false, "pageUp breaks follow");

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
  };
  const res = update(model, keyMsg({ kind: "esc" }));
  assertEquals(res.length, 1, "no command dispatched");
  assertEquals(res[0].followTail, true);
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

// ---------------------------------------------------------------------------
// palette: custom slash commands
// ---------------------------------------------------------------------------

Deno.test("palette: a custom command seeds the editor with `/name `", () => {
  const program = buildProgram({
    client: {
      ...fakeClient,
      commands: [{
        name: "review",
        description: "Review code",
        argumentHint: "<file>",
      }],
    },
    theme: darkTheme,
    version: "test",
    workspace: "/w",
    size: { cols: 40, rows: 8 },
  });
  const u = step(program.update);
  let model = program.init()[0];

  model = u(model, textMsg("p", { ctrl: true })); // open the palette
  assertEquals(model.palette.open, true);
  for (const ch of "rev") model = u(model, textMsg(ch));
  model = u(model, keyMsg(key("enter")));

  assertEquals(model.palette.open, false, "palette closed after execute");
  assertEquals(
    model.editor.lines.join("\n"),
    "/review ",
    "custom command seeded into the editor for the user to complete",
  );
});

Deno.test("palette: an arg-taking builtin seeds the editor like a custom command", () => {
  const program = buildProgram({
    client: {
      ...fakeClient,
      commands: [{ name: "model", description: "custom shadow attempt" }],
    },
    theme: darkTheme,
    version: "test",
    workspace: "/w",
    size: { cols: 40, rows: 8 },
  });
  const u = step(program.update);
  let model = program.init()[0];

  model = u(model, textMsg("p", { ctrl: true })); // open the palette
  // Filter down to the two same-named "/model" entries (builtin + custom);
  // both take an argument, so either way the editor is seeded, not executed.
  for (const ch of "model") model = u(model, textMsg(ch));
  model = u(model, keyMsg(key("enter")));

  assertEquals(model.palette.open, false, "palette closed after execute");
  assertEquals(
    model.editor.lines.join("\n"),
    "/model ",
    "arg-taking builtin seeded into the editor for the user to complete",
  );
  assertEquals(
    model.state.notices.length,
    0,
    "nothing executed yet — no /model notice",
  );
});

Deno.test("palette: a no-arg builtin executes locally (no editor seed)", () => {
  const program = newProgram();
  const u = step(program.update);
  let model = program.init()[0];

  model = u(model, textMsg("p", { ctrl: true })); // open the palette
  // "/mcp" is the only item matching "mcp"; it needs no argument and runs.
  for (const ch of "mcp") model = u(model, textMsg(ch));
  model = u(model, keyMsg(key("enter")));

  assertEquals(
    model.editor.lines.join("\n"),
    "",
    "no-arg builtin ran locally — the editor was not seeded",
  );
  assertEquals(
    model.state.notices.some((n) => n.text.includes("MCP")),
    true,
    "the /mcp notice was posted",
  );
});

// ---------------------------------------------------------------------------
// completion menu (slash commands)
// ---------------------------------------------------------------------------

Deno.test("completion menu: auto-pops on a `/partial` token; enter submits the selection", () => {
  const { calls, client } = recordingClient();
  const program = programWith(client);
  const update = program.update;
  let model = program.init()[0];

  model = typeText(update, model, "/hel");
  // menu is live (derived): enter accepts the only candidate (/help) AND
  // submits it through the local builtin dispatch — no prompt is sent.
  const res = update(model, keyMsg(key("enter")));
  model = res[0];
  assertEquals(res.length, 1, "/help ran fully locally");
  assertEquals(calls.prompt, []);
  assertEquals(model.editor.lines.join("\n"), "", "buffer cleared by submit");
  assertEquals(
    model.state.notices.some((n) => n.text.includes("ctrl+p palette")),
    true,
    "the /help output was posted",
  );
});

Deno.test("completion menu: tab accepts the selection without submitting", () => {
  const { calls, client } = recordingClient();
  const program = programWith(client);
  const update = program.update;
  let model = program.init()[0];

  model = typeText(update, model, "/hel");
  model = update(model, keyMsg(key("tab")))[0];
  assertEquals(model.editor.lines.join("\n"), "/help ");
  assertEquals(calls.prompt, []);
  assertEquals(model.state.notices.length, 0, "nothing executed");
});

Deno.test("completion menu: enter on `/compact` runs the command", async () => {
  const { calls, client } = recordingClient();
  const program = programWith(client);
  const update = program.update;
  let model = program.init()[0];

  model = typeText(update, model, "/compact");
  const res = update(model, keyMsg(key("enter")));
  model = await runFirstCmd(update, res);
  assertEquals(calls.compact, 1);
  assertEquals(calls.prompt, []);
});

Deno.test("completion menu: arrows/ctrl+n/ctrl+p move the selection (and ctrl+p does NOT open the palette)", () => {
  const { client } = recordingClient();
  const program = programWith(client);
  const update = program.update;
  let model = program.init()[0];

  model = typeText(update, model, "/");
  // 12 candidates (10 builtins + /quit + /new), sorted; selection starts at 0.
  model = update(model, keyMsg(key("down")))[0];
  assertEquals(model.completion.selected, 1);
  model = update(model, textMsg("n", { ctrl: true }))[0];
  assertEquals(model.completion.selected, 2);
  model = update(model, keyMsg(key("up")))[0];
  assertEquals(model.completion.selected, 1);
  model = update(model, textMsg("p", { ctrl: true }))[0];
  assertEquals(model.completion.selected, 0);
  assertEquals(model.palette.open, false, "palette stayed closed");
  // wraps around both ends
  model = update(model, keyMsg(key("up")))[0];
  assertEquals(model.completion.selected, 11, "up from 0 wraps to the last");
});

Deno.test("completion menu: esc dismisses; arrows fall back to editor history", async () => {
  const { calls, client } = recordingClient();
  const program = programWith(client);
  const update = program.update;
  let model = program.init()[0];

  // seed one history entry (the prompt cmd resolves ok)
  model = typeText(update, model, "hello");
  model = await runFirstCmd(update, update(model, keyMsg(key("enter"))));
  assertEquals(calls.prompt, ["hello"]);

  model = typeText(update, model, "/hel");
  model = update(model, keyMsg({ kind: "esc" }))[0];
  assertEquals(model.completion.dismissed, true, "menu dismissed");
  assertEquals(
    model.editor.lines.join("\n"),
    "/hel",
    "esc did not touch the buffer (no turn interrupt / scroll reset)",
  );

  // arrows are editor history again
  model = update(model, keyMsg(key("up")))[0];
  assertEquals(model.editor.lines.join("\n"), "hello");
});

Deno.test("completion menu: typing re-arms a dismissed menu; tab re-opens it too", () => {
  const { client } = recordingClient();
  const program = programWith(client);
  const update = program.update;
  let model = program.init()[0];

  model = typeText(update, model, "/he");
  model = update(model, keyMsg({ kind: "esc" }))[0];
  assertEquals(model.completion.dismissed, true);

  // buffer change re-arms
  model = update(model, textMsg("l"))[0];
  assertEquals(model.completion.dismissed, false);
  assertEquals(model.completion.selected, 0);

  // esc + tab re-opens
  model = update(model, keyMsg({ kind: "esc" }))[0];
  assertEquals(model.completion.dismissed, true);
  model = update(model, keyMsg(key("tab")))[0];
  assertEquals(model.completion.dismissed, false, "tab re-opened the menu");
});

Deno.test("completion menu: args after the command name never open a menu", async () => {
  const { calls, client } = recordingClient({
    commands: [{ name: "review", description: "Review code" }],
  });
  const program = programWith(client);
  const update = program.update;
  let model = program.init()[0];

  // `/review sr` has a space, so no menu derives; enter submits the text
  // verbatim as a prompt (menu did not eat the key).
  model = typeText(update, model, "/review sr");
  const res = update(model, keyMsg(key("enter")));
  assertEquals(res.length > 1, true, "prompt dispatched");
  await res[1]?.run();
  assertEquals(calls.prompt, ["/review sr"]);
});

// ---------------------------------------------------------------------------
// built-in slash command dispatch (editor submit + palette share one path)
// ---------------------------------------------------------------------------

/** A fakeClient that records calls and scripts the command endpoints. */
const recordingClient = (overrides: Partial<TuiClient> = {}) => {
  const calls = {
    prompt: [] as string[],
    setModel: [] as string[],
    setEffort: [] as string[],
    setInputDelivery: [] as string[],
    compact: 0,
    newSession: 0,
    resume: [] as string[],
  };
  const client: TuiClient = {
    ...fakeClient,
    prompt: (text: string) => {
      calls.prompt.push(text);
      return Promise.resolve({
        ok: true,
        status: 202,
        disposition: "started",
      });
    },
    setModel: (m: string) => {
      calls.setModel.push(m);
      return Promise.resolve({ ok: true, model: m, contextWindow: 256_000 });
    },
    setEffort: (e: string) => {
      calls.setEffort.push(e);
      return Promise.resolve({ ok: true, effort: e });
    },
    setInputDelivery: (inputDelivery) => {
      calls.setInputDelivery.push(inputDelivery);
      return Promise.resolve({ ok: true, inputDelivery });
    },
    compact: () => {
      calls.compact++;
      return Promise.resolve({ ok: true });
    },
    newSession: () => {
      calls.newSession++;
      return Promise.resolve();
    },
    ...overrides,
  };
  return { calls, client };
};

const programWith = (client: TuiClient): Built =>
  buildProgram({
    client,
    theme: darkTheme,
    version: "test",
    workspace: "/w",
    size: { cols: 40, rows: 8 },
  });

/** Type `s` into the editor one key at a time. */
const typeText = (
  update: Built["update"],
  model: Model,
  s: string,
): Model => {
  let m = model;
  for (const ch of s) m = update(m, textMsg(ch))[0];
  return m;
};

/** Run the first dispatched Cmd and feed its Msg back into update. */
const runFirstCmd = async (
  update: Built["update"],
  res: readonly [Model, ...Array<{ run: () => Promise<Msg | undefined> }>],
): Promise<Model> => {
  const c = res[1];
  if (c === undefined) throw new Error("expected a dispatched command");
  const msg = await c.run();
  if (msg === undefined) throw new Error("command produced no message");
  return update(res[0], msg)[0];
};

Deno.test("returned inputs restore one draft at a time and never auto-submit", async () => {
  const { calls, client } = recordingClient();
  const program = programWith(client);
  const update = program.update;
  let model = program.init()[0];

  model = update(model, {
    type: "tui:interrupt",
    ok: true,
    status: 200,
    returnedInputs: [
      { sourceText: "first recovered" },
      { sourceText: "second recovered" },
      { sourceText: "third recovered" },
    ],
  })[0];

  assertEquals(model.editor.lines.join("\n"), "first recovered");
  assertEquals(model.draftBacklog, ["second recovered", "third recovered"]);
  assertEquals(model.restoredDraftActive, true);
  assertEquals(calls.prompt, [], "restoring drafts does not submit them");

  const firstSubmit = update(model, keyMsg(key("enter")));
  assertEquals(
    firstSubmit[0].editor.lines.join("\n"),
    "second recovered",
    "submitting one draft reveals the next",
  );
  assertEquals(firstSubmit[0].draftBacklog, ["third recovered"]);
  assertEquals(firstSubmit[0].restoredDraftActive, true);
  model = await runFirstCmd(update, firstSubmit);

  assertEquals(calls.prompt, ["first recovered"]);
  assertEquals(
    model.editor.lines.join("\n"),
    "second recovered",
    "the next draft remains waiting after the request finishes",
  );
});

Deno.test("a cleared recovered draft advances only after explicit submit", () => {
  const program = newProgram();
  const update = program.update;
  let model = program.init()[0];

  model = update(model, {
    type: "tui:interrupt",
    ok: true,
    status: 200,
    returnedInputs: [
      { sourceText: "current recovered" },
      { sourceText: "older backlog" },
    ],
  })[0];
  model = update(model, textMsg("u", { ctrl: true }))[0];
  assertEquals(model.editor.lines.join("\n"), "");
  assertEquals(model.restoredDraftActive, true);

  model = update(model, {
    type: "tui:interrupt",
    ok: true,
    status: 200,
    returnedInputs: [{ sourceText: "newer recovered" }],
  })[0];
  assertEquals(
    model.editor.lines.join("\n"),
    "",
    "a recovery event does not implicitly advance the cleared draft slot",
  );
  assertEquals(model.draftBacklog, [
    "older backlog",
    "newer recovered",
  ]);

  const submitted = update(model, keyMsg(key("enter")));
  assertEquals(submitted.length, 1, "blank recovered draft is not sent");
  assertEquals(submitted[0].editor.lines.join("\n"), "older backlog");
  assertEquals(submitted[0].draftBacklog, ["newer recovered"]);
  assertEquals(submitted[0].restoredDraftActive, true);
});

Deno.test("returned inputs are all discarded when the editor is non-empty", () => {
  const { client } = recordingClient();
  const program = programWith(client);
  const update = program.update;
  let model = program.init()[0];

  model = typeText(update, model, "local unsubmitted text");
  model = update(model, {
    type: "tui:interrupt",
    ok: true,
    status: 200,
    returnedInputs: [
      { sourceText: "discard one" },
      { sourceText: "discard two" },
    ],
  })[0];

  assertEquals(model.editor.lines.join("\n"), "local unsubmitted text");
  assertEquals(model.draftBacklog, []);
  assertEquals(model.restoredDraftActive, false);
});

Deno.test("turn failure recovery uses the same editor collision rule", () => {
  const program = newProgram();
  const update = program.update;
  let model = program.init()[0];

  model = update(
    model,
    sse("input.recovered", {
      reason: "turn_failed",
      inputs: [
        { sourceText: "failed steer one" },
        { sourceText: "failed steer two" },
      ],
    }),
  )[0];
  assertEquals(model.editor.lines.join("\n"), "failed steer one");
  assertEquals(model.draftBacklog, ["failed steer two"]);

  model = update(model, textMsg("!"))[0];
  model = update(
    model,
    sse("input.recovered", {
      reason: "turn_failed",
      inputs: [{ sourceText: "must be discarded" }],
    }),
  )[0];
  assertEquals(model.editor.lines.join("\n"), "failed steer one!");
  assertEquals(
    model.draftBacklog,
    ["failed steer two"],
    "newly returned input is not appended behind an occupied editor",
  );
});

Deno.test("slash dispatch: a builtin command is intercepted (no prompt)", () => {
  // A custom command named "help" tries to shadow the builtin — builtin wins.
  const { calls, client } = recordingClient({
    commands: [{ name: "help", description: "custom shadow" }],
  });
  const program = programWith(client);
  const update = program.update;
  let model = program.init()[0];

  model = typeText(update, model, "/help");
  const res = update(model, keyMsg(key("enter")));
  model = res[0];

  assertEquals(res.length, 1, "handled fully locally — no async command");
  assertEquals(calls.prompt, [], "builtin was NOT sent as a prompt");
  assertEquals(
    model.state.notices.some((n) => n.text.includes("ctrl+p palette")),
    true,
    "the key-bindings line was posted",
  );
  assertEquals(
    model.state.notices.some((n) => n.text.includes("/compact")),
    true,
    "the builtin command list was posted",
  );
  assertEquals(
    model.state.notices.some((n) => n.text.includes("custom commands")),
    true,
    "custom commands are listed too",
  );
});

Deno.test("slash dispatch: a custom command still goes through prompt", async () => {
  const { calls, client } = recordingClient({
    commands: [{ name: "review", description: "Review code" }],
  });
  const program = programWith(client);
  const update = program.update;
  let model = program.init()[0];

  model = typeText(update, model, "/review src/x.ts");
  const res = update(model, keyMsg(key("enter")));
  assertEquals(res.length > 1, true, "the prompt command was dispatched");
  await res[1]?.run();
  assertEquals(
    calls.prompt,
    ["/review src/x.ts"],
    "custom command text reaches the server verbatim (expanded there)",
  );
});

Deno.test("slash dispatch: /quit quits (alias for /exit)", () => {
  const { calls, client } = recordingClient();
  const program = programWith(client);
  const update = program.update;
  let model = program.init()[0];

  model = typeText(update, model, "/quit");
  const res = update(model, keyMsg(key("enter")));
  assertEquals(res[0].quitting, true);
  assertEquals(calls.prompt, []);
});

Deno.test("slash dispatch: bare /model shows the current model", () => {
  const { calls, client } = recordingClient();
  const program = programWith(client);
  const update = program.update;
  let model = program.init()[0];
  model = update(model, sse("session.created", { model: "m1" }))[0];

  model = typeText(update, model, "/model");
  const res = update(model, keyMsg(key("enter")));

  assertEquals(res.length, 1, "no async work for the bare form");
  assertEquals(calls.setModel, []);
  assertEquals(
    res[0].state.notices.some((n) => n.text === "model: m1"),
    true,
  );
});

Deno.test("slash dispatch: /model <ref> calls setModel and updates state", async () => {
  const { calls, client } = recordingClient();
  const program = programWith(client);
  const update = program.update;
  let model = program.init()[0];

  model = typeText(update, model, "/model openai/gpt-5");
  const res = update(model, keyMsg(key("enter")));
  assertEquals(calls.prompt, [], "no prompt was sent");

  model = await runFirstCmd(update, res);
  assertEquals(calls.setModel, ["openai/gpt-5"]);
  assertEquals(model.state.model, "openai/gpt-5");
  assertEquals(model.state.contextWindow, 256_000);
  assertEquals(
    model.state.notices.some((n) => n.text === "model: openai/gpt-5"),
    true,
  );
});

Deno.test("slash dispatch: /model failure posts the server error", async () => {
  const { client } = recordingClient({
    setModel: () => Promise.resolve({ ok: false, error: "unknown model: bad" }),
  });
  const program = programWith(client);
  const update = program.update;
  let model = program.init()[0];

  model = typeText(update, model, "/model bad");
  const res = update(model, keyMsg(key("enter")));
  model = await runFirstCmd(update, res);

  assertEquals(model.state.model, null, "model unchanged on failure");
  assertEquals(
    model.state.notices.some((n) =>
      n.kind === "error" && n.text === "unknown model: bad"
    ),
    true,
  );
});

Deno.test("slash dispatch: /effort sets and then reports the effort", async () => {
  const { calls, client } = recordingClient();
  const program = programWith(client);
  const update = program.update;
  let model = program.init()[0];

  // bare form: nothing set yet -> model default
  model = typeText(update, model, "/effort");
  let res = update(model, keyMsg(key("enter")));
  assertEquals(res.length, 1);
  assertEquals(
    res[0].state.notices.some((n) => n.text === "effort: (model default)"),
    true,
  );
  model = res[0];

  model = typeText(update, model, "/effort high");
  res = update(model, keyMsg(key("enter")));
  model = await runFirstCmd(update, res);
  assertEquals(calls.setEffort, ["high"]);
  assertEquals(model.effort, "high");
  assertEquals(
    model.state.notices.some((n) => n.text === "effort: high"),
    true,
  );

  // bare form now reports the recorded effort
  model = typeText(update, model, "/effort");
  res = update(model, keyMsg(key("enter")));
  assertEquals(
    res[0].state.notices.some((n) => n.text === "effort: high"),
    true,
  );
});

Deno.test("slash dispatch: /delivery reports, validates, and updates the server mode", async () => {
  const { calls, client } = recordingClient();
  const program = programWith(client);
  const update = program.update;
  let model = program.init()[0];

  model = typeText(update, model, "/delivery");
  let res = update(model, keyMsg(key("enter")));
  assertEquals(res.length, 1);
  assertEquals(
    res[0].state.notices.some((n) => n.text === "delivery: steer"),
    true,
  );

  model = res[0];
  model = typeText(update, model, "/delivery invalid");
  res = update(model, keyMsg(key("enter")));
  assertEquals(res.length, 1);
  assertEquals(calls.setInputDelivery, []);
  assertEquals(
    res[0].state.notices.some((n) =>
      n.kind === "error" && n.text === "delivery must be steer or queue"
    ),
    true,
  );

  model = res[0];
  model = typeText(update, model, "/delivery queue");
  res = update(model, keyMsg(key("enter")));
  model = await runFirstCmd(update, res);
  assertEquals(calls.setInputDelivery, ["queue"]);
  assertEquals(
    model.state.notices.some((n) => n.text === "delivery: queue"),
    true,
  );
});

Deno.test("slash dispatch: /compact accepted posts a compacting notice", async () => {
  const { calls, client } = recordingClient();
  const program = programWith(client);
  const update = program.update;
  let model = program.init()[0];

  model = typeText(update, model, "/compact");
  const res = update(model, keyMsg(key("enter")));
  model = await runFirstCmd(update, res);

  assertEquals(calls.compact, 1);
  assertEquals(
    model.state.notices.some((n) => n.text === "compacting context…"),
    true,
  );
});

Deno.test("slash dispatch: /compact during a turn asks to wait", async () => {
  const { client } = recordingClient({
    compact: () =>
      Promise.resolve({
        ok: false,
        code: "turn_in_flight",
        error: "turn in flight",
      }),
  });
  const program = programWith(client);
  const update = program.update;
  let model = program.init()[0];

  model = typeText(update, model, "/compact");
  const res = update(model, keyMsg(key("enter")));
  model = await runFirstCmd(update, res);

  assertEquals(
    model.state.notices.some((n) => n.text.includes("current turn")),
    true,
  );
});

Deno.test("slash dispatch: /clear starts a new session and resets state", async () => {
  const { calls, client } = recordingClient();
  const program = programWith(client);
  const update = program.update;
  let model = program.init()[0];

  // seed some session state to prove it is dropped
  model = update(model, sse("turn.started"))[0];
  model = update(
    model,
    sse("assistant.message", { parts: [{ type: "text", text: "old" }] }),
  )[0];
  model = update(model, sse("turn.completed", { stopReason: "stop" }))[0];
  model = { ...model, transcriptScroll: 3, followTail: false };
  assertEquals(model.state.messages.length, 1);

  model = typeText(update, model, "/clear");
  const res = update(model, keyMsg(key("enter")));
  model = await runFirstCmd(update, res);

  assertEquals(calls.newSession, 1);
  assertEquals(calls.prompt, []);
  assertEquals(model.state.messages, []);
  assertEquals(model.state.toolCalls, []);
  assertEquals(model.state.streaming, null);
  assertEquals(model.transcriptScroll, 0);
  assertEquals(model.followTail, true);
  assertEquals(
    model.state.notices.some((n) => n.text.includes("new session")),
    true,
  );
});

// -- /resume -----------------------------------------------------------------

const sessionInfoRow = (
  sessionId: string,
  model = "m2",
  title?: string,
): SessionInfo => ({
  sessionId,
  workspace: "/w",
  model,
  createdAt: 1,
  updatedAt: 2,
  status: "idle",
  ...(title !== undefined ? { title } : {}),
});

const resumeHistory = (): ReadonlyArray<RecordedEvent> =>
  [
    {
      seq: 1,
      ts: 1,
      sessionId: "s_old",
      type: "session.created",
      data: {
        workspace: "/w",
        model: "m2",
        contextWindow: 50_000,
        mcpServers: [],
      },
    },
    {
      seq: 2,
      ts: 2,
      sessionId: "s_old",
      type: "user.message",
      data: { text: "old question", sourceText: "old question" },
    },
    {
      seq: 3,
      ts: 3,
      sessionId: "s_old",
      type: "assistant.message",
      data: { parts: [{ type: "text", text: "old answer" }] },
    },
  ] as unknown as RecordedEvent[];

Deno.test("slash dispatch: bare /resume lists sessions", async () => {
  const { client } = recordingClient({
    listSessions: () =>
      Promise.resolve([
        sessionInfoRow("s1", "m1"),
        sessionInfoRow("s_old", "m2", "old question"),
      ]),
  });
  const program = programWith(client);
  const update = program.update;
  let model = program.init()[0];

  model = typeText(update, model, "/resume");
  const res = update(model, keyMsg(key("enter")));
  model = await runFirstCmd(update, res);

  assertEquals(
    model.state.notices.some((n) =>
      n.text.includes("s_old") && n.text.includes("old question")
    ),
    true,
    "session rows listed with their titles",
  );
  assertEquals(
    model.state.notices.some((n) => n.text.includes("/resume <id>")),
    true,
    "the usage hint was posted",
  );
});

Deno.test("slash dispatch: /resume <prefix> rebuilds the session from history", async () => {
  const { calls, client } = recordingClient({
    listSessionIds: () => Promise.resolve(["s1", "s_old"]),
    resume: (id: string) => {
      calls.resume.push(id);
      return Promise.resolve({
        info: sessionInfoRow("s_old"),
        history: resumeHistory(),
      });
    },
  });
  const program = programWith(client);
  const update = program.update;
  let model = program.init()[0];
  // stray scroll state to prove the switch resets it
  model = { ...model, transcriptScroll: 4, followTail: false };

  model = typeText(update, model, "/resume s_o");
  const res = update(model, keyMsg(key("enter")));
  model = await runFirstCmd(update, res);

  assertEquals(calls.resume, ["s_old"], "unique prefix resolved to s_old");
  assertEquals(
    model.state.messages.map((m) => m.text),
    ["old question", "old answer"],
    "messages rebuilt from the recorded history",
  );
  assertEquals(model.state.model, "m2");
  assertEquals(model.state.contextWindow, 50_000);
  assertEquals(model.transcriptScroll, 0);
  assertEquals(model.followTail, true);
  assertEquals(
    model.state.notices.some((n) => n.text === "resumed session s_old"),
    true,
  );
});

Deno.test("slash dispatch: /resume with an unknown id posts an error", async () => {
  const { calls, client } = recordingClient({
    listSessionIds: () => Promise.resolve(["s1"]),
  });
  const program = programWith(client);
  const update = program.update;
  let model = program.init()[0];

  model = typeText(update, model, "/resume nope");
  const res = update(model, keyMsg(key("enter")));
  model = await runFirstCmd(update, res);

  assertEquals(calls.resume, [], "client.resume never called");
  assertEquals(
    model.state.notices.some((n) =>
      n.kind === "error" && n.text.includes("session not found: nope")
    ),
    true,
  );
});

// ---------------------------------------------------------------------------
// subagent channels (spawned -> channel; completed -> finalized; selector)
// ---------------------------------------------------------------------------

const childJournal: RecordedEvent[] = [
  {
    seq: 1,
    ts: 1,
    sessionId: "c1",
    type: "session.created",
    data: {
      workspace: "/w",
      model: "m",
      mcpServers: [],
      parentSessionId: "s1",
    },
  },
  {
    seq: 2,
    ts: 2,
    sessionId: "c1",
    type: "user.message",
    data: { parts: [{ type: "text", text: "child prompt" }] },
  },
];

Deno.test("subagent.spawned creates a channel and child-history builds its transcript", () => {
  const { update, init } = programWith({
    ...fakeClient,
    subagentHistory: () => Promise.resolve(childJournal),
  });
  let [model] = init();
  [model] = update(
    model,
    sse("subagent.spawned", {
      parentSessionId: "s1",
      childSessionId: "c1",
      prompt: "child prompt",
      name: "explorer",
      callId: "call-1",
    }),
  );
  assertEquals(model.channels.length, 1);
  assertEquals(model.channels[0].status, "running");
  assertEquals(model.channels[0].name, "explorer");
  [model] = update(model, {
    type: "tui:child-history",
    childSessionId: "c1",
    events: childJournal,
  } as Msg);
  assertEquals(model.channels[0].state.messages[0].text, "child prompt");
});

Deno.test("down activates the selector at newest editor history and enter switches channels", () => {
  const { update, init } = programWith(fakeClient);
  let [model] = init();
  [model] = update(
    model,
    sse("subagent.spawned", {
      parentSessionId: "s1",
      childSessionId: "c1",
      prompt: "p",
      callId: "call-1",
    }),
  );
  [model] = update(model, keyMsg(key("down")));
  assertEquals(model.agentSelector, { active: true, selected: 0 });
  [model] = update(model, keyMsg(key("down")));
  [model] = update(model, keyMsg(key("enter")));
  assertEquals(model.channel, "c1");
  assertEquals(model.agentSelector, null);
});

Deno.test("subagent.completed finalizes the channel and esc deactivates the selector", () => {
  const { update, init } = programWith(fakeClient);
  let [model] = init();
  [model] = update(
    model,
    sse("subagent.spawned", {
      parentSessionId: "s1",
      childSessionId: "c1",
      prompt: "p",
      callId: "call-1",
    }),
  );
  [model] = update(
    model,
    sse("subagent.completed", {
      parentSessionId: "s1",
      childSessionId: "c1",
      callId: "call-1",
      ok: false,
      usage: { inputTokens: 4, outputTokens: 2 },
      durationMs: 500,
    }),
  );
  assertEquals(model.channels[0].status, "failed");
  assertEquals(model.channels[0].tokensIn, 4);
  [model] = update(model, keyMsg(key("down")));
  assertEquals(model.agentSelector !== null, true);
  [model] = update(model, keyMsg({ kind: "esc" }));
  assertEquals(model.agentSelector, null);
});
