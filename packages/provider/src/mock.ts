import { Effect, Stream } from "effect";
import type { ProviderAdapter } from "./contract.ts";
import type { ChatRequest, ModelRef, StreamEvent, Usage } from "./domain.ts";

/**
 * Network-free mock provider for end-to-end smoke tests.
 *
 * The mock ignores the message content (except for the two markers below) and
 * instead counts how many prior `tool` role messages are in the request —
 * that count is the turn index the agent is about to sample. The scripted
 * turn sequence is the one the smoke harness drives end-to-end:
 *
 *   turn 1 (0 prior tool results) → ToolCall `read` { path: "./README-smoke.txt" }
 *   turn 2 (1 prior tool result)  → ToolCall `bash` { command: "echo hello-from-niuma" }
 *   turn 3 (2+ prior tool results)→ final text "smoke done", Finish stop
 *
 * Two first-user-message markers extend the script without disturbing the
 * legacy sequence for any other driver:
 *
 *   - contains "subagent"    → read → bash → ToolCall `spawn_subagent`
 *     { prompt: "smoke child" } → final text "smoke done" (the smoke harness's
 *     subagent-observability flow)
 *   - contains "smoke child" → immediate final text "smoke child done", so the
 *     spawned child finishes in one call with no tools and no approvals
 *
 * listModels returns a single placeholder model so any caller that probes
 * the catalog before streaming never touches the network.
 *
 * Wiring: tests and the smoke harness inject it via BootstrapDeps.infra
 * (or construct it directly), so production runs are unaffected.
 */
export const makeMockProvider = (): ProviderAdapter => {
  const listModels = (): Effect.Effect<ReadonlyArray<ModelRef>> =>
    Effect.succeed([
      { id: "mock-smoke", name: "mock-smoke" },
    ]);

  const stream = (req: ChatRequest): Stream.Stream<StreamEvent> => {
    const toolResults = countToolResults(req.messages);
    return Stream.fromIterable(
      scriptFor(toolResults, firstUserText(req.messages)),
    );
  };

  return { listModels, stream };
};

const countToolResults = (
  messages: ReadonlyArray<ChatRequest["messages"][number]>,
): number => messages.filter((m) => m.role === "tool").length;

const firstUserText = (
  messages: ReadonlyArray<ChatRequest["messages"][number]>,
): string => messages.find((m) => m.role === "user")?.content ?? "";

const MOCK_USAGE: Usage = {
  promptTokens: 1,
  completionTokens: 1,
  totalTokens: 2,
};

const READ_TURN: ReadonlyArray<StreamEvent> = [
  {
    _tag: "ToolCall",
    id: "call_mock_read",
    name: "read",
    arguments: JSON.stringify({ path: "./README-smoke.txt" }),
  },
  { _tag: "Finish", reason: "tool_calls", usage: MOCK_USAGE },
];

const BASH_TURN: ReadonlyArray<StreamEvent> = [
  {
    _tag: "ToolCall",
    id: "call_mock_bash",
    name: "bash",
    arguments: JSON.stringify({ command: "echo hello-from-niuma" }),
  },
  { _tag: "Finish", reason: "tool_calls", usage: MOCK_USAGE },
];

const SPAWN_TURN: ReadonlyArray<StreamEvent> = [
  {
    _tag: "ToolCall",
    id: "call_mock_spawn",
    name: "spawn_subagent",
    arguments: JSON.stringify({ prompt: "smoke child", name: "smoke-child" }),
  },
  { _tag: "Finish", reason: "tool_calls", usage: MOCK_USAGE },
];

const FINAL_TURN: ReadonlyArray<StreamEvent> = [
  { _tag: "TextDelta", text: "smoke done" },
  { _tag: "Finish", reason: "stop", usage: MOCK_USAGE },
];

const CHILD_TURN: ReadonlyArray<StreamEvent> = [
  { _tag: "TextDelta", text: "smoke child done" },
  { _tag: "Finish", reason: "stop", usage: MOCK_USAGE },
];

const scriptFor = (
  toolResultsSeen: number,
  firstUser: string,
): ReadonlyArray<StreamEvent> => {
  if (firstUser.includes("smoke child")) return CHILD_TURN;
  if (firstUser.includes("subagent")) {
    switch (toolResultsSeen) {
      case 0:
        return READ_TURN;
      case 1:
        return BASH_TURN;
      case 2:
        return SPAWN_TURN;
      default:
        return FINAL_TURN;
    }
  }
  switch (toolResultsSeen) {
    case 0:
      return READ_TURN;
    case 1:
      return BASH_TURN;
    default:
      return FINAL_TURN;
  }
};
