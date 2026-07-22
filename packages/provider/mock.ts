import { Effect, Stream } from "effect";
import type { ProviderAdapter } from "./contract.ts";
import type { ChatRequest, ModelRef, StreamEvent, Usage } from "./domain.ts";

/**
 * Network-free mock provider for end-to-end smoke tests.
 *
 * The mock ignores the message content and instead counts how many prior
 * `tool` role messages are in the request — that count is the turn index
 * the agent is about to sample. The scripted turn sequence is the one the
 * smoke harness drives end-to-end:
 *
 *   turn 1 (0 prior tool results) → ToolCall `read` { path: "./README-smoke.txt" }
 *   turn 2 (1 prior tool result)  → ToolCall `bash` { command: "echo hello-from-niuma" }
 *   turn 3 (2+ prior tool results)→ final text "smoke done", Finish stop
 *
 * listModels returns a single placeholder model so any caller that probes
 * the catalog before streaming never touches the network.
 *
 * Wiring lives in @niuma/server's bootstrap (gated on NIUMA_MOCK_PROVIDER=1)
 * so production runs are unaffected.
 */
export const makeMockProvider = (): ProviderAdapter => {
  const listModels = (): Effect.Effect<ReadonlyArray<ModelRef>> =>
    Effect.succeed([
      { id: "mock-smoke", name: "mock-smoke" },
    ]);

  const stream = (req: ChatRequest): Stream.Stream<StreamEvent> => {
    const toolResults = countToolResults(req.messages);
    return Stream.fromIterable(scriptFor(toolResults));
  };

  return { listModels, stream };
};

const countToolResults = (
  messages: ReadonlyArray<ChatRequest["messages"][number]>,
): number => messages.filter((m) => m.role === "tool").length;

const MOCK_USAGE: Usage = {
  promptTokens: 1,
  completionTokens: 1,
  totalTokens: 2,
};

const scriptFor = (toolResultsSeen: number): ReadonlyArray<StreamEvent> => {
  switch (toolResultsSeen) {
    case 0:
      return [
        {
          _tag: "ToolCall",
          id: "call_mock_read",
          name: "read",
          arguments: JSON.stringify({ path: "./README-smoke.txt" }),
        },
        { _tag: "Finish", reason: "tool_calls", usage: MOCK_USAGE },
      ];
    case 1:
      return [
        {
          _tag: "ToolCall",
          id: "call_mock_bash",
          name: "bash",
          arguments: JSON.stringify({ command: "echo hello-from-niuma" }),
        },
        { _tag: "Finish", reason: "tool_calls", usage: MOCK_USAGE },
      ];
    default:
      return [
        { _tag: "TextDelta", text: "smoke done" },
        { _tag: "Finish", reason: "stop", usage: MOCK_USAGE },
      ];
  }
};
