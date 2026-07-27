import type { Effect, Stream } from "effect";
import type { ChatRequest, ModelRef, StreamEvent } from "./domain.ts";
import type { ProviderError } from "./errors.ts";

export interface ProviderAdapter {
  readonly listModels: () => Effect.Effect<
    ReadonlyArray<ModelRef>,
    ProviderError
  >;
  readonly stream: (
    req: ChatRequest,
  ) => Stream.Stream<StreamEvent, ProviderError>;
}
