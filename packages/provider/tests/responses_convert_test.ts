import { assertEquals } from "@std/assert";
import {
  messagesToResponses,
  toolsToResponses,
} from "../src/responses_convert.ts";

// Direct unit tests for messagesToResponses / toolsToResponses: the adapter
// tests exercise them indirectly, but the projection logic deserves a
// dedicated pass so any quiet regression in the wire-shape mapping is
// caught at the converter boundary.

Deno.test("messagesToResponses: user text is wrapped as input_text", () => {
  assertEquals(
    messagesToResponses([{ role: "user", content: "hi" }]),
    [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hi" }],
    }],
  );
});

Deno.test("messagesToResponses: a system role is dropped (hoisted to instructions)", () => {
  // The adapter hoists system into the top-level `instructions` field; the
  // converter never emits a system item, even if one slips through.
  assertEquals(messagesToResponses([{ role: "system", content: "sys" }]), []);
});

Deno.test("messagesToResponses: tool result preserves call_id and emits function_call_output", () => {
  assertEquals(
    messagesToResponses([
      { role: "tool", content: "result", toolCallId: "call_42" },
    ]),
    [
      {
        type: "function_call_output",
        call_id: "call_42",
        output: "result",
      },
    ],
  );
});

Deno.test("messagesToResponses: tool result with no toolCallId uses empty call_id", () => {
  // The convert layer doesn't error on missing toolCallId — Call_id is left
  // empty so the provider can reject the bad call rather than crash the loop.
  assertEquals(
    messagesToResponses([{ role: "tool", content: "r" }]),
    [{ type: "function_call_output", call_id: "", output: "r" }],
  );
});

Deno.test("messagesToResponses: assistant turn with no content and no tool calls emits nothing", () => {
  // Pure reasoning turn: no visible text, no tool calls, no empty assistant
  // output_text item. The reasoning items stand alone.
  assertEquals(
    messagesToResponses([
      {
        role: "assistant",
        content: "",
        reasoningContent: [{ text: "thought", encrypted: "enc-1" }],
      },
    ]),
    [
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "thought" }],
        encrypted_content: "enc-1",
      },
    ],
  );
});

Deno.test("messagesToResponses: assistant turn with mixed encrypted+plain+empty reasoning blocks", () => {
  // Mixed blocks: only the encrypted one becomes a reasoning item; blocks
  // lacking an `encrypted` credential are dropped (the credentials are the
  // load-bearing replay field; folding plain text would pollute the turn).
  assertEquals(
    messagesToResponses([
      {
        role: "assistant",
        content: "answer",
        reasoningContent: [
          { text: "plain-no-creds" },
          { text: "thought-A", encrypted: "enc-A" },
          { text: "", encrypted: "enc-empty" },
          { text: "thought-B", encrypted: "enc-B" },
        ],
      },
    ]),
    [
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "thought-A" }],
        encrypted_content: "enc-A",
      },
      {
        type: "reasoning",
        summary: [],
        encrypted_content: "enc-empty",
      },
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "thought-B" }],
        encrypted_content: "enc-B",
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "answer" }],
      },
    ],
  );
});

Deno.test("messagesToResponses: function_call items precede the visible message in order", () => {
  // Generation order: tool calls come AFTER the visible text in the source
  // message, but the wire reorders so the tool-call items come after the
  // message — matches the model "sees its own text, then reflects on it"
  // timeline. Verify the position.
  assertEquals(
    messagesToResponses([
      {
        role: "assistant",
        content: "answer",
        toolCalls: [
          { id: "c1", name: "n1", arguments: "{}" },
        ],
      },
    ]),
    [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "answer" }],
      },
      { type: "function_call", call_id: "c1", name: "n1", arguments: "{}" },
    ],
  );
});

Deno.test("messagesToResponses: assistant turn with only tool calls and empty content", () => {
  // No empty output_text item is emitted when there's no visible body.
  assertEquals(
    messagesToResponses([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "c1", name: "n1", arguments: "{}" },
        ],
      },
    ]),
    [
      { type: "function_call", call_id: "c1", name: "n1", arguments: "{}" },
    ],
  );
});

Deno.test("messagesToResponses: full conversation round-trip shape", () => {
  // A realistic sequence: user, assistant with reasoning+text, tool result,
  // assistant with tool calls. Verifies the concatenated order matches the
  // domain message order.
  const items = messagesToResponses([
    { role: "user", content: "q1" },
    {
      role: "assistant",
      content: "answer1",
      reasoningContent: [{ text: "thinking", encrypted: "enc-1" }],
    },
    { role: "tool", content: "r1", toolCallId: "c1" },
    {
      role: "assistant",
      content: "answer2",
      toolCalls: [{ id: "c2", name: "n2", arguments: "{}" }],
    },
  ]);
  assertEquals(items, [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "q1" }],
    },
    {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "thinking" }],
      encrypted_content: "enc-1",
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "answer1" }],
    },
    { type: "function_call_output", call_id: "c1", output: "r1" },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "answer2" }],
    },
    { type: "function_call", call_id: "c2", name: "n2", arguments: "{}" },
  ]);
});

Deno.test("messagesToResponses: empty input yields an empty output", () => {
  assertEquals(messagesToResponses([]), []);
});

// ----- toolsToResponses -----------------------------------------------------

Deno.test("toolsToResponses: empty array yields empty array", () => {
  assertEquals(toolsToResponses([]), []);
});

Deno.test("toolsToResponses: every tool is strict:false regardless of description/parameters", () => {
  // The Responses function tool schema defaults `strict` to true; niuma opts
  // out explicitly because niuma tool schemas are not guaranteed strict-mode
  // conformant. Verify both branches preserve strict:false.
  assertEquals(
    toolsToResponses([
      { name: "a" },
      { name: "b", description: "d" },
      { name: "c", parameters: { type: "object" } },
      { name: "d", description: "d", parameters: { type: "object" } },
    ]),
    [
      { type: "function", name: "a", strict: false },
      { type: "function", name: "b", description: "d", strict: false },
      {
        type: "function",
        name: "c",
        parameters: { type: "object" },
        strict: false,
      },
      {
        type: "function",
        name: "d",
        description: "d",
        parameters: { type: "object" },
        strict: false,
      },
    ],
  );
});

Deno.test("toolsToResponses: does not leak fields beyond the wire shape", () => {
  // Properties not declared on ResponsesFunctionTool must be dropped during
  // the projection — strictOptionalPropertyTypes-safe mapping.
  const out = toolsToResponses([
    { name: "x", description: "d", parameters: { type: "object" } },
  ]);
  assertEquals(out, [
    {
      type: "function",
      name: "x",
      description: "d",
      parameters: { type: "object" },
      strict: false,
    },
  ]);
  assertEquals(Object.keys(out[0]!).sort(), [
    "description",
    "name",
    "parameters",
    "strict",
    "type",
  ]);
});
