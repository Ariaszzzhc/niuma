import { Context, Effect, Layer, Stream } from "effect";
import type {
  RecordedEvent,
  SessionCreatedData,
  SessionInfo,
} from "@niuma/schema";
import { EventLog } from "./event_log.ts";
import { Projection } from "./projection.ts";

// ============================================================================
// Effect v4 service tag — class-based form, matches the pattern used by
// permission/PermissionEngine and provider/Provider.
// ============================================================================

export interface EventLogServiceShape {
  open: (sessionId: string) => Effect.Effect<EventLog>;
  create: (
    sessionId: string,
    data: SessionCreatedData,
  ) => Effect.Effect<EventLog>;
  replay: (sessionId: string) => Stream.Stream<RecordedEvent, Error>;
  listSessionFiles: () => Effect.Effect<readonly string[]>;
}

// deno-lint-ignore no-slow-types
export class EventLogService extends Context.Service<
  EventLogService,
  EventLogServiceShape
>()("@niuma/store/EventLogService") {}

export interface ProjectionServiceShape {
  migrate: () => Effect.Effect<void>;
  apply: (event: RecordedEvent) => Effect.Effect<void>;
  rebuildAll: () => Effect.Effect<number>;
  listSessions: () => Effect.Effect<readonly SessionInfo[]>;
  getSession: (id: string) => Effect.Effect<SessionInfo | null>;
  close: () => Effect.Effect<void>;
}

// deno-lint-ignore no-slow-types
export class ProjectionService extends Context.Service<
  ProjectionService,
  ProjectionServiceShape
>()("@niuma/store/ProjectionService") {}

// ============================================================================
// Live layers.
// ============================================================================

export const EventLogServiceLive: Layer.Layer<EventLogService> = Layer.succeed(
  EventLogService,
  {
    open: (sessionId) => Effect.sync(() => EventLog.open(sessionId)),
    create: (sessionId, data) =>
      Effect.sync(() => EventLog.create(sessionId, data)),
    replay: (sessionId) =>
      Stream.fromAsyncIterable(
        EventLog.replay(sessionId),
        (e) => (e instanceof Error ? e : new Error(String(e))),
      ),
    listSessionFiles: () => Effect.sync(() => EventLog.listSessionFiles()),
  },
);

export const ProjectionServiceLive: Layer.Layer<ProjectionService> = Layer
  .effect(
    ProjectionService,
    Effect.gen(function* () {
      // acquireRelease so db.destroy() runs when the layer (and its scope) closes.
      const projection = yield* Effect.acquireRelease(
        Effect.sync(() => Projection.open()),
        (p) => Effect.promise(() => p.close()),
      );
      yield* Effect.promise(() => projection.migrate());
      return {
        migrate: () => Effect.promise(() => projection.migrate()),
        apply: (event) => Effect.promise(() => projection.apply(event)),
        rebuildAll: () =>
          Effect.gen(function* () {
            yield* Effect.promise(() => projection.rebuildAll());
            return EventLog.listSessionFiles(projection.dataDir).length;
          }),
        listSessions: () => Effect.promise(() => projection.listSessions()),
        getSession: (id) => Effect.promise(() => projection.getSession(id)),
        close: () => Effect.promise(() => projection.close()),
      };
    }),
  );
