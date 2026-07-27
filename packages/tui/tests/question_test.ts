// ===========================================================================
// @niuma/tui — structured question surface tests
// ===========================================================================

import { assertEquals } from "@std/assert";
import type { InputEvent, KeyMods, NamedKey } from "@niuma/tuikit";
import { stringWidth } from "@niuma/tuikit";
import {
  createQuestionState,
  questionReducer,
  renderQuestionPanel,
} from "../src/components/question.ts";

stringWidth("niuma");

const mods: KeyMods = {
  shift: false,
  alt: false,
  ctrl: false,
  super: false,
};
const key = (value: NamedKey): InputEvent => ({
  kind: "key",
  key: value,
  mods,
  eventType: "press",
});
const text = (value: string): InputEvent => ({
  kind: "text",
  text: value,
  mods,
  eventType: "press",
});

const input = {
  question: "Which implementation should Niuma use?",
  options: ["Keep the current path", "Use the new path"],
};

Deno.test("question submits the selected option when answer is empty", () => {
  const state = createQuestionState("ap1", input)!;
  const [moved] = questionReducer(state, key("down"));
  const [, action] = questionReducer(moved, key("enter"));
  assertEquals(action, {
    type: "answer",
    feedback: "Use the new path",
  });
});

Deno.test("question typed answer takes precedence and stays separate", () => {
  const state = createQuestionState("ap1", input)!;
  const [typed] = questionReducer(state, text("A custom answer"));
  const [, action] = questionReducer(typed, key("enter"));
  assertEquals(action, { type: "answer", feedback: "A custom answer" });
});

Deno.test("question esc declines", () => {
  const state = createQuestionState("ap1", input)!;
  const [, action] = questionReducer(state, { kind: "esc" });
  assertEquals(action, { type: "reject", feedback: "dismissed" });
});

Deno.test("question panel fits width and exposes its answer cursor", () => {
  const state = createQuestionState("ap1", input)!;
  const surface = renderQuestionPanel(state, 32, {
    border: "default",
    accent: "default",
    text: "default",
    muted: "default",
    placeholder: "default",
  });
  assertEquals(
    surface.lines.every((line) =>
      line.spans.reduce((n, span) => n + stringWidth(span.text), 0) <= 32
    ),
    true,
  );
  assertEquals(surface.cursor?.shape, "bar");
});
