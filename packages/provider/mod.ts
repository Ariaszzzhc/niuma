export type {
  ChatRequest,
  FinishReason,
  Message,
  ModelRef,
  Role,
  StreamEvent,
  ThinkingConfig,
  ToolCall,
  ToolDef,
  Usage,
} from "./src/domain.ts";

export {
  AuthFailed,
  ContextOverflow,
  InvalidResponse,
  isFatal,
  isRetryable,
  Network,
  Overloaded,
  RateLimited,
} from "./src/errors.ts";
export type { ProviderError } from "./src/errors.ts";

export type { ProviderAdapter } from "./src/contract.ts";

export {
  providerRetrySchedule,
  retryOptions,
  STREAM_MAX_RETRIES,
  withRetry,
} from "./src/retry.ts";

export {
  messagesToOpenAI,
  openAIToMessages,
  toolsToOpenAI,
} from "./src/convert.ts";
export type {
  OpenAIMessage,
  OpenAITool,
  OpenAIToolCall,
} from "./src/convert.ts";

export { parseOpenAISSE } from "./src/sse.ts";

export { niumaFetch } from "./src/http.ts";

export { makeOpenAIAdapter, normalizeConfig } from "./src/openai.ts";
export type { OpenAIProviderConfig } from "./src/openai.ts";

export {
  makeAnthropicAdapter,
  messagesToAnthropic,
  toolsToAnthropic,
} from "./src/anthropic.ts";
export type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicProviderConfig,
  AnthropicTextBlock,
  AnthropicThinkingBlock,
  AnthropicTool,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
} from "./src/anthropic.ts";

// Responses API adapter. Only the factory + config + the OAuth token-source
// interface + the codex rewrite target are public; the Responses wire
// vocabulary (responses_convert.ts / responses_sse.ts internals) stays
// package-private (design rule 1: vendor types live in the provider package
// only and never cross the boundary).
export { CODEX_BACKEND_URL, makeResponsesAdapter } from "./src/responses.ts";
export type {
  OAuthTokenSource,
  ResponsesAdapterConfig,
} from "./src/responses.ts";

export { makeMockProvider } from "./src/mock.ts";
