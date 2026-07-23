import { Data } from "effect";

export class Network extends Data.TaggedError("Network")<{ cause: unknown }> {}
export class RateLimited extends Data.TaggedError("RateLimited")<{ retryAfterMs?: number }> {}
export class Overloaded extends Data.TaggedError("Overloaded")<{ message?: string }> {}
export class ContextOverflow extends Data.TaggedError("ContextOverflow")<{ message?: string }> {}
export class AuthFailed extends Data.TaggedError("AuthFailed")<{ message?: string }> {}
export class InvalidResponse extends Data.TaggedError("InvalidResponse")<{ message: string }> {}

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
