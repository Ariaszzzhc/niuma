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

export { provideAdapter, Provider } from "./src/contract.ts";
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

export {
  makeOpenAIAdapter,
  normalizeConfig,
  OpenAIProviderLive,
} from "./src/openai.ts";
export type { OpenAIProviderConfig } from "./src/openai.ts";

export {
  makeAnthropicAdapter,
  messagesToAnthropic,
  toolsToAnthropic,
  AnthropicProviderLive,
} from "./src/anthropic.ts";
export type {
  AnthropicProviderConfig,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicTextBlock,
  AnthropicThinkingBlock,
  AnthropicToolUseBlock,
  AnthropicToolResultBlock,
  AnthropicTool,
} from "./src/anthropic.ts";

export { makeMockProvider } from "./src/mock.ts";
