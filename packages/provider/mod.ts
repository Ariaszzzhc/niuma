export const PROVIDER_VERSION = "0.0.0";

export type {
  ChatRequest,
  FinishReason,
  Message,
  ModelRef,
  Role,
  StreamEvent,
  ToolCall,
  ToolDef,
  Usage,
} from "./src/domain.ts";

export {
  AuthFailed,
  ContextOverflow,
  InvalidResponse,
  Network,
  Overloaded,
  RateLimited,
  isFatal,
  isRetryable,
} from "./src/errors.ts";
export type { ProviderError } from "./src/errors.ts";

export { Provider, provideAdapter } from "./src/contract.ts";
export type { ProviderAdapter } from "./src/contract.ts";

export { providerRetrySchedule, retryOptions, withRetry, STREAM_MAX_RETRIES } from "./src/retry.ts";

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

export { makeMockProvider } from "./src/mock.ts";
