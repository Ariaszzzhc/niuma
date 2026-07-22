import { Effect, Layer } from "effect";
import { ensureSchema, makeProjection, type Projection } from "./projection.ts";
import { makeEventLog, type EventLog } from "./eventLog.ts";
import { Kernel, KernelLive, makeKernel } from "./kernel.ts";
import { makeEventBus, type EventBus } from "./eventBus.ts";
import {
  SessionManager,
  SessionManagerLive,
  type SessionManagerInfra,
} from "./session.ts";
import { dataPaths, type DataPaths } from "./paths.ts";
import { makeOpenAIAdapter, loadConfigFromEnv, makeMockProvider } from "@niuma/provider";
import {
  MemoryPermissionEngine,
  ToolRegistry,
  type SubagentResult,
} from "@niuma/tools";
import { runTurn } from "@niuma/agent";
import {
  kernelApprovalGateway,
  kernelEmitLive,
  kernelEventLog,
  makeToolPipeline,
} from "./agent_deps.ts";

export interface BootstrapDeps {
  readonly paths?: DataPaths;
  readonly eventLog?: EventLog;
  readonly projection?: Projection;
  readonly bus?: EventBus;
  readonly infra?: Partial<SessionManagerInfra>;
}

export interface BootstrapResult {
  readonly paths: DataPaths;
  readonly eventLog: EventLog;
  readonly projection: Projection;
  readonly bus: EventBus;
  readonly infra: SessionManagerInfra;
  readonly kernelLayer: Layer.Layer<Kernel, never, never>;
  readonly sessionLayer: Layer.Layer<SessionManager, never, Kernel>;
}

const envGet = (name: string): string | undefined => {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
};

// Subagent depth is bounded at 1 (per the agent contract: depth-1 limit).
// We track depth by sessionId so the spawn_subagent tool cannot recurse
// indefinitely. A child of a depth-0 parent becomes depth-1; a depth-1
// parent refuses to spawn further children.
const SUBAGENT_DEPTH_LIMIT = 1;

const newSessionId = (): string => {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

export const bootstrap = async (
  deps: BootstrapDeps = {},
): Promise<BootstrapResult> => {
  const paths = deps.paths ?? dataPaths();
  await Deno.mkdir(paths.root, { recursive: true });
  await Deno.mkdir(paths.sessions, { recursive: true });

  const eventLog = deps.eventLog ??
    makeEventLog({ sessionsDir: paths.sessions });
  const projection = deps.projection ?? await ensureSchema(paths.db);
  const bus = deps.bus ?? await Effect.runPromise(makeEventBus());

  // Build the kernel eagerly so the spawn_subagent closure below can capture
  // it. The Layer we hand downstream wraps the same value (Layer.succeed),
  // keeping a single kernel instance across the bootstrap + session layer.
  const kernel = await Effect.runPromise(
    makeKernel({ eventLog, projection, bus }),
  );

  // ---- Agent infra: OpenAI-compatible provider + tool pipeline. ----
  // makeOpenAIAdapter only touches the network on stream()/listModels(),
  // so constructing it here never fetches.
  const providerConfig = loadConfigFromEnv();
  // NIUMA_MOCK_PROVIDER=1 swaps in a network-free scripted provider so the
  // smoke harness can drive a full tunnel→worker→agent→tool round-trip
  // without hitting a real backend. Production code paths are unchanged.
  const useMockProvider = envGet("NIUMA_MOCK_PROVIDER") === "1";
  const provider = deps.infra?.provider ??
    (useMockProvider
      ? makeMockProvider()
      : makeOpenAIAdapter(providerConfig));
  const registry = new ToolRegistry();
  const workspace = envGet("NIUMA_WORKSPACE") ?? Deno.cwd();
  const engine = new MemoryPermissionEngine({ cwd: workspace });
  const defaultModel = providerConfig.defaultModel;

  // spawn_subagent wiring: create a child session, record lineage events,
  // and recursively run a turn on the child. Depth is bounded by
  // SUBAGENT_DEPTH_LIMIT (1) so a subagent cannot spawn further subagents.
  const depthBySession = new Map<string, number>();
  const spawnSubagent = async (req: {
    readonly prompt: string;
    readonly mode?: "default" | "read-only";
    readonly parentSessionId: string;
  }): Promise<SubagentResult> => {
    const parentDepth = depthBySession.get(req.parentSessionId) ?? 0;
    if (parentDepth >= SUBAGENT_DEPTH_LIMIT) {
      return {
        sessionId: req.parentSessionId,
        text: "Subagent depth limit reached; cannot spawn further subagents.",
      };
    }
    const childId = newSessionId();
    depthBySession.set(childId, parentDepth + 1);

    try {
      // Record the child session and the parent → child lineage.
      await Effect.runPromise(kernel.append({
        type: "session.created",
        sessionId: childId,
        data: { workspace, model: defaultModel },
      }));
      await Effect.runPromise(kernel.append({
        type: "subagent.spawned",
        sessionId: req.parentSessionId,
        data: {
          parentSessionId: req.parentSessionId,
          childSessionId: childId,
          prompt: req.prompt,
        },
      }));
      // runTurn drains its steer queue but does not prepend an initial
      // user.message on its own, so seed one before sampling.
      await Effect.runPromise(kernel.append({
        type: "user.message",
        sessionId: childId,
        data: { parts: [{ type: "text", text: req.prompt }] },
      }));

      const result = await Effect.runPromise(
        runTurn(childId, {
          eventLog: kernelEventLog(kernel),
          provider,
          tools: toolsForSubagent,
          approvals: kernelApprovalGateway(kernel),
          emitLive: kernelEmitLive(kernel),
          model: defaultModel,
          workspace,
          mode: req.mode === "read-only" ? "read-only" : "full",
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => ({
              stopReason: "stop" as const,
              usage: { inputTokens: 0, outputTokens: 0 },
              text: `error: ${String(cause)}`,
            })),
          ),
        ),
      );
      return { sessionId: childId, text: result.text };
    } finally {
      depthBySession.delete(childId);
    }
  };

  // Subagent-facing pipeline: same shape as the parent's, with the
  // spawnSubagent closure wired through so a child can itself refuse further
  // nesting at the depth limit.
  const toolsForSubagent = makeToolPipeline({
    registry,
    engine,
    spawnSubagent,
  });

  const tools = deps.infra?.tools ??
    makeToolPipeline({ registry, engine, spawnSubagent });

  const infra: SessionManagerInfra = {
    provider,
    tools,
    defaultModel,
    defaultWorkspace: workspace,
  };

  // Wrap the eagerly-built kernel in a Layer so downstream consumers (the
  // session layer, the runtime built in createServerApp) all see the same
  // instance the spawn_subagent closure captured.
  const kernelLayer = Layer.succeed(Kernel, kernel);
  const sessionLayer = SessionManagerLive(infra);

  return {
    paths,
    eventLog,
    projection,
    bus,
    infra,
    kernelLayer,
    sessionLayer,
  };
};

export { Kernel, SessionManager, KernelLive };
export { makeProjection, ensureSchema } from "./projection.ts";
export { makeEventLog } from "./eventLog.ts";
export { makeEventBus } from "./eventBus.ts";
