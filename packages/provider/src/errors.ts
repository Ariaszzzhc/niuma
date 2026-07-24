import { Data } from "effect";

// deno-lint-ignore no-slow-types
export class Network extends Data.TaggedError("Network")<{ cause: unknown }> {}
// deno-lint-ignore no-slow-types
export class RateLimited
  extends Data.TaggedError("RateLimited")<{ retryAfterMs?: number }> {}
// deno-lint-ignore no-slow-types
export class Overloaded
  extends Data.TaggedError("Overloaded")<{ message?: string }> {}
// deno-lint-ignore no-slow-types
export class ContextOverflow
  extends Data.TaggedError("ContextOverflow")<{ message?: string }> {}
// deno-lint-ignore no-slow-types
export class AuthFailed
  extends Data.TaggedError("AuthFailed")<{ message?: string }> {}
// deno-lint-ignore no-slow-types
export class InvalidResponse
  extends Data.TaggedError("InvalidResponse")<{ message: string }> {}

export type ProviderError =
  | Network
  | RateLimited
  | Overloaded
  | ContextOverflow
  | AuthFailed
  | InvalidResponse;

export const isRetryable = (e: ProviderError): boolean =>
  e._tag === "Network" || e._tag === "RateLimited" || e._tag === "Overloaded";

export const isFatal = (e: ProviderError): boolean => !isRetryable(e);
