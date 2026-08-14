// ===========================================================================
// @niuma/tui — specialized and generic tool renderer tests
// ===========================================================================

import { assert, assertEquals } from "@std/assert";
import { stringWidth, type StyledLine } from "@niuma/tuikit";
import {
  parseMcpToolName,
  renderReadToolGroup,
  renderToolCall,
  type ToolCallView,
} from "../src/components/tool_call.ts";
import { darkTheme } from "../src/theme.ts";

stringWidth("niuma");

const text = (lines: readonly StyledLine[]): string =>
  lines.map((line) => line.spans.map((span) => span.text).join("")).join("\n");

const call = (
  values: Partial<ToolCallView> & Pick<ToolCallView, "name">,
): ToolCallView => ({
  status: "done",
  inputSummary: "",
  resultLines: [],
  expanded: false,
  ...values,
});

Deno.test("MCP tool renderer decodes provenance and shows three visual rows", () => {
  const value = call({
    name: "mcp__github__search_issues",
    input: { query: "is:open label:bug" },
    resultLines: ["one", "two", "three", "four", "five"],
  });
  const lines = renderToolCall(value, 60, darkTheme);
  const output = text(lines);
  assert(output.includes("search_issues"));
  assert(output.includes("MCP · github"));
  assert(output.includes("is:open label:bug"));
  assert(output.includes("one"));
  assert(output.includes("three"));
  assert(!output.includes("four"));
  assert(output.includes("ctrl+o"));
  assertEquals(parseMcpToolName(value.name), {
    server: "github",
    tool: "search_issues",
  });
});

Deno.test("unknown tools use the generic fallback", () => {
  const output = text(renderToolCall(
    call({
      name: "vendor_magic",
      input: { url: "https://example.test/resource" },
      resultLines: ["result"],
    }),
    60,
    darkTheme,
  ));
  assert(output.includes("vendor_magic"));
  assert(output.includes("https://example.test/resource"));
  assert(output.includes("result"));
});

Deno.test("apply_patch renderer surfaces file and colored diff lines", () => {
  const lines = renderToolCall(
    call({
      name: "apply_patch",
      input: {
        patch:
          "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch",
      },
    }),
    60,
    darkTheme,
  );
  const output = text(lines);
  assert(output.includes("Patch"));
  assert(output.includes("src/a.ts"));
  assert(output.includes("-old"));
  assert(output.includes("+new"));
  assert(
    lines.some((line) =>
      line.spans.some((span) =>
        JSON.stringify(span.style.fg) === JSON.stringify(darkTheme.diffAdd)
      )
    ),
  );
  assert(
    lines.some((line) =>
      line.spans.some((span) =>
        JSON.stringify(span.style.fg) === JSON.stringify(darkTheme.diffDelete)
      )
    ),
  );
});

Deno.test("consecutive reads render as one compact group", () => {
  const lines = renderReadToolGroup(
    [
      call({ name: "read", input: { path: "src/a.ts" } }),
      call({
        name: "read",
        input: { path: "src/b.ts", offset: 20, limit: 10 },
      }),
    ],
    50,
    darkTheme,
  );
  const output = text(lines);
  assert(output.includes("Read"));
  assert(output.includes("2 files"));
  assert(output.includes("src/a.ts"));
  assert(output.includes("src/b.ts:20-29"));
});

Deno.test("specialized tool detail never exceeds narrow widths", () => {
  const value = call({
    name: "bash",
    input: { command: "printf a-very-long-command-with-many-arguments" },
    resultLines: [
      "a very long output row that needs to wrap into several visual rows",
      "second line",
      "third line",
      "fourth line",
    ],
  });
  for (const width of [24, 30, 40, 80]) {
    const lines = renderToolCall(value, width, darkTheme);
    assertEquals(
      lines.every((line) =>
        line.spans.reduce((sum, span) => sum + stringWidth(span.text), 0) <=
          width
      ),
      true,
      `all rows fit width ${width}`,
    );
  }
});

Deno.test("spawn_subagent card shows status badge, duration and tokens", () => {
  const view = call({
    name: "spawn_subagent",
    input: { prompt: "inspect", mode: "default" },
    inputSummary: "inspect",
    resultLines: ["ok"],
    durationMs: 1200,
    subagent: {
      status: "failed",
      durationMs: 1200,
      tokensIn: 40,
      tokensOut: 7,
    },
  });
  const output = text(renderToolCall(view, 80, darkTheme));
  assert(output.includes("Subagent"));
  assert(output.includes("◍"), "failed badge");
  assert(output.includes("40/7"), "token counts");
  assert(output.includes("1.2s"), "duration");
});
