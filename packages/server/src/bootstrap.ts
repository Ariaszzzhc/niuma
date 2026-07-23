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
import { makeOpenAIAdapter } from "@niuma/provider";
import {
  ConfigError,
  loadConfigFile,
  readAuthFile,
  resolveModelRef,
  substituteEnv,
  niumaPaths,
  type NiumaConfig,
} from "@niuma/config";
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
  /** Pre-loaded config; tests/smoke inject this to skip the filesystem. */
  readonly config?: NiumaConfig;
}

export interface BootstrapResult {
  readonly paths: DataPaths;
  readonly eventLog: EventLog;
  readonly projection: Projection;
  readonly bus: EventBus;
  readonly infra: SessionManagerInfra;
  readonly config: NiumaConfig;
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

  // ---- Configuration: config.toml + auth.json. ----
  // The provider package takes an explicit config; where it comes from is
  // resolved here, once, at boot. Tests/smoke inject `deps.config` and a
  // `deps.infra.provider` so neither the config file nor the network is
  // touched.
  const config = deps.config ?? await loadConfigFile(niumaPaths().configFile);

  // Build the kernel eagerly so the spawn_subagent closure below can capture
  // it. The Layer we hand downstream wraps the same value (Layer.succeed),
  // keeping a single kernel instance across the bootstrap + session layer.
  const kernel = await Effect.runPromise(
    makeKernel({ eventLog, projection, bus }),
  );

  // ---- Agent infra: provider + tool pipeline. ----
  // makeOpenAIAdapter only touches the network on stream()/listModels(),
  // so constructing it here never fetches.
  const provider = deps.infra?.provider ??
    (await makeProviderFromConfig(config));
  const registry = new ToolRegistry();
  const workspace = envGet("NIUMA_WORKSPACE") ?? Deno.cwd();
  const engine = new MemoryPermissionEngine({ cwd: workspace });

  // Default model: config.toml's top-level `model` (provider/model-id). Its
  // per-model limits feed the agent loop's compaction threshold and output
  // cap.
  const defaultRef = config.model;
  let defaultModel = deps.infra?.defaultModel ?? "";
  let defaultContextWindow = deps.infra?.defaultContextWindow;
  let defaultMaxTokens = deps.infra?.defaultMaxTokens;
  if (defaultRef && !deps.infra?.provider) {
    const resolved = resolveModelRef(config, defaultRef);
    defaultModel = resolved.modelId;
    defaultContextWindow = resolved.model.contextWindow;
    defaultMaxTokens = resolved.model.maxOutput;
  }

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
          ...(defaultContextWindow !== undefined
            ? { contextWindow: defaultContextWindow }
            : {}),
          ...(defaultMaxTokens !== undefined
            ? { maxTokens: defaultMaxTokens }
            : {}),
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
    ...(defaultContextWindow !== undefined
      ? { defaultContextWindow }
      : {}),
    ...(defaultMaxTokens !== undefined ? { defaultMaxTokens } : {}),
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
    config,
    kernelLayer,
    sessionLayer,
  };
};

/**
 * Build the provider adapter from config.toml + auth.json.
 *
 * The adapter is bound to the config's default provider (the one named by
 * the top-level `model` reference). Credential lookup order:
 *   1. auth.json[<providerId>]      (the canonical credential store)
 *   2. provider api_key with {env:VAR} substitution (explicit escape hatch)
 * Missing credentials fail at boot with a pointer to both locations.
 */
const makeProviderFromConfig = async (config: NiumaConfig) => {
  if (!config.model) {
    throw new ConfigError(
      `config: no default model set. Add e.g.\n  model = "myprovider/my-model"` +
        `\nto ${niumaPaths().configFile}`,
    );
  }
  const resolved = resolveModelRef(config, config.model);
  const auth = await readAuthFile(niumaPaths().authFile);
  const entry = auth[resolved.provider.id];
  const apiKey = entry?.type === "api"
    ? entry.key
    : resolved.provider.apiKey !== undefined
    ? substituteEnv(resolved.provider.apiKey)
    : undefined;
  if (!apiKey) {
    throw new ConfigError(
      `config: no credentials for provider "${resolved.provider.id}". ` +
        `Add an entry to ${niumaPaths().authFile}:\n` +
        `  { "${resolved.provider.id}": { "type": "api", "key": "..." } }`,
    );
  }
  return makeOpenAIAdapter({
    baseUrl: resolved.provider.baseUrl,
    apiKey,
    defaultModel: resolved.modelId,
  });
};

export { Kernel, SessionManager, KernelLive };
export { makeProjection, ensureSchema } from "./projection.ts";
export { makeEventLog } from "./eventLog.ts";
export { makeEventBus } from "./eventBus.ts";
