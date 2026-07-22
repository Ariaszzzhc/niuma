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
} from "./domain.ts";

export {
  AuthFailed,
  ContextOverflow,
  InvalidResponse,
  Network,
  Overloaded,
  RateLimited,
  isFatal,
  isRetryable,
} from "./errors.ts";
export type { ProviderError } from "./errors.ts";

export { Provider, provideAdapter } from "./contract.ts";
export type { ProviderAdapter } from "./contract.ts";

export { providerRetrySchedule, retryOptions, withRetry, STREAM_MAX_RETRIES } from "./retry.ts";

export {
  messagesToOpenAI,
  openAIToMessages,
  toolsToOpenAI,
} from "./convert.ts";
export type {
  OpenAIMessage,
  OpenAITool,
  OpenAIToolCall,
} from "./convert.ts";

export { parseOpenAISSE } from "./sse.ts";

export {
  OpenAIProviderLive,
  loadConfigFromEnv,
  makeOpenAIAdapter,
} from "./openai.ts";
export type { OpenAIProviderConfig } from "./openai.ts";

export { makeMockProvider } from "./mock.ts";
