import { assertEquals } from "@std/assert";
import {
  type AgentStripEntry,
  moveAgentSelection,
  renderAgentStrip,
} from "../src/components/agent_strip.ts";

const colors = {
  text: "default",
  muted: "default",
  accent: "default",
  border: "default",
} as const;

const entries: AgentStripEntry[] = [
  {
    id: "main",
    label: "main",
    status: "main",
    tokensIn: null,
    tokensOut: null,
    durationMs: null,
  },
  {
    id: "c1",
    label: "inspect the code",
    status: "running",
    tokensIn: 12,
    tokensOut: 3,
    durationMs: null,
  },
  {
    id: "c2",
    label: "write tests",
    status: "failed",
    tokensIn: 5,
    tokensOut: 1,
    durationMs: 900,
  },
];

Deno.test("renderAgentStrip inactive renders one row per entry without a marker", () => {
  const rows = renderAgentStrip(entries, false, 0, 60, colors);
  assertEquals(rows.length, 3);
  const rowText = (i: number) => rows[i].spans.map((s) => s.text).join("");
  assertEquals(rowText(0).includes("main"), true);
  assertEquals(rowText(1).includes("inspect the code"), true);
  assertEquals(rowText(0).includes("▶"), false);
  assertEquals(rowText(1).includes("▶"), false);
});

Deno.test("renderAgentStrip active renders one row per entry and highlights the selection", () => {
  const rows = renderAgentStrip(entries, true, 1, 60, colors);
  assertEquals(rows.length, 3);
  const selectedText = rows[1].spans.map((s) => s.text).join("");
  assertEquals(selectedText.includes("inspect the code"), true);
  assertEquals(selectedText.includes("▶"), true);
});

Deno.test("renderAgentStrip truncates a long label with an ellipsis", () => {
  const long: AgentStripEntry[] = [{
    id: "c1",
    label: "x".repeat(120),
    status: "running",
    tokensIn: null,
    tokensOut: null,
    durationMs: null,
  }];
  const rows = renderAgentStrip(long, false, 0, 120, colors);
  const text = rows[0].spans.map((s) => s.text).join("");
  assertEquals(text.includes("…"), true);
  assertEquals(text.length < 60, true);
});

Deno.test("moveAgentSelection wraps around", () => {
  assertEquals(moveAgentSelection(0, 3, -1), 2);
  assertEquals(moveAgentSelection(2, 3, 1), 0);
});
