import type { Message, ToolDef } from "./domain.ts";

// =============================================================================
// Wire types - Responses API input-item vocabulary.
// =============================================================================
// Per the niuma design rule, vendor field names (`input_text`, `output_text`,
// `function_call`, `function_call_output`, `reasoning`, `encrypted_content`,
// `summary_text`, `instructions`) are this provider's private vocabulary and
// MUST NOT leak into the core domain or past packages/provider/mod.ts. They
// are declared (and exported from this file only) so the adapter and its tests
// can construct/inspect payloads; mod.ts re-exports none of them.

export interface ResponsesInputText {
  readonly type: "input_text";
  readonly text: string;
}

export interface ResponsesOutputText {
  readonly type: "output_text";
  readonly text: string;
}

export interface ResponsesSummaryText {
  readonly type: "summary_text";
  readonly text: string;
}

export interface ResponsesMessageItem {
  readonly type: "message";
  readonly role: "user" | "assistant";
  readonly content: ReadonlyArray<ResponsesInputText | ResponsesOutputText>;
}

export interface ResponsesFunctionCallItem {
  readonly type: "function_call";
  readonly call_id: string;
  readonly name: string;
  // Responses passes tool arguments as a JSON string (same wire shape as Chat
  // Completions); niuma's ToolCall.arguments is already that string, so it
  // flows through unchanged.
  readonly arguments: string;
}

export interface ResponsesFunctionCallOutputItem {
  readonly type: "function_call_output";
  readonly call_id: string;
  readonly output: string;
}

export interface ResponsesReasoningItem {
  readonly type: "reasoning";
  // Summary text reconstructed from the reasoningContent block's `text`. Empty
  // when only the encrypted credential was captured (encrypted_content is the
  // load-bearing replay field).
  readonly summary: ReadonlyArray<ResponsesSummaryText>;
  // The opaque replay credential, held verbatim from the prior turn's
  // encrypted_content and sent back untouched (design rule 3: encrypted is the
  // neutral replay container - Anthropic signature today, Responses
  // encrypted_content tomorrow - held verbatim, replayed verbatim).
  readonly encrypted_content: string;
}

export type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem
  | ResponsesReasoningItem;

export interface ResponsesFunctionTool {
  readonly type: "function";
  readonly name: string;
  readonly description?: string;
  readonly parameters?: Record<string, unknown>;
  // strict:false - niuma's tool schemas are not guaranteed conformant to
  // Structured Outputs' strict mode, so we opt out rather than risk a 400.
  // (The Chat Completions convert layer achieves the same by simply not
  // emitting `strict`, which defaults to false; here it is stated explicitly
  // because the Responses function-tool schema defaults `strict` to true.)
  readonly strict: false;
}

// =============================================================================
// Message[] -> Responses input items
// =============================================================================
export const messagesToResponses = (
  messages: ReadonlyArray<Message>,
): ResponsesInputItem[] => {
  const out: ResponsesInputItem[] = [];
  for (const m of messages) {
    switch (m.role) {
      case "system":
        // System prompt is hoisted to the top-level `instructions` field by
        // buildBody (responses.ts); it never appears in the Responses input
        // list. Skip defensively in case a system Message slips through.
        continue;
      case "user":
        out.push({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: m.content }],
        });
        continue;
      case "tool":
        // Tool results are standalone function_call_output items referencing
        // the prior function_call's call_id (no wrapping user message, unlike
        // Anthropic's tool_result blocks).
        out.push({
          type: "function_call_output",
          call_id: m.toolCallId ?? "",
          output: m.content,
        });
        continue;
      case "assistant": {
        // Reasoning replay: only blocks carrying an `encrypted` credential
        // become reasoning items. Blocks without `encrypted` originated from
        // a non-Responses provider as plain-text thinking and carry no
        // encrypted_content the Responses API could verify - replaying them
        // would be rejected, and folding their text into the visible body
        // would pollute the turn. Discard, mirroring the Anthropic convert
        // layer's handling of signature-less blocks. The encrypted_content is
        // the load-bearing replay field; summary text rides along for display.
        for (const b of m.reasoningContent ?? []) {
          if (b.encrypted !== undefined) {
            out.push({
              type: "reasoning",
              summary: b.text !== ""
                ? [{ type: "summary_text", text: b.text }]
                : [],
              encrypted_content: b.encrypted,
            });
          }
        }
        // Visible assistant text follows the reasoning, matching generation
        // order (model reasons, then answers). Emitted only when non-empty so
        // a pure tool-call turn does not leave an empty output_text item.
        if (m.content !== "") {
          out.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: m.content }],
          });
        }
        // Function calls close the turn (the tool results come back as
        // function_call_output items in the following items).
        for (const tc of m.toolCalls ?? []) {
          out.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          });
        }
        continue;
      }
    }
  }
  return out;
};

// =============================================================================
// ToolDef[] -> Responses function tools
// =============================================================================
export const toolsToResponses = (
  tools: ReadonlyArray<ToolDef>,
): ResponsesFunctionTool[] =>
  tools.map((t): ResponsesFunctionTool => ({
    type: "function",
    name: t.name,
    strict: false,
    ...(t.description !== undefined ? { description: t.description } : {}),
    ...(t.parameters !== undefined ? { parameters: t.parameters } : {}),
  }));
