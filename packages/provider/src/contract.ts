import { Context, type Effect, Layer, type Stream } from "effect";
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

// deno-lint-ignore no-slow-types
export class Provider extends Context.Service<Provider, ProviderAdapter>()(
  "Provider",
) {}

export const provideAdapter = (
  adapter: ProviderAdapter,
): Layer.Layer<Provider> => Layer.succeed(Provider, adapter);
