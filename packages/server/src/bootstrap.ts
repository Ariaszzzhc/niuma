import { Effect, Layer } from "effect";
import { ensureSchema, type Projection } from "./projection.ts";
import {
  CorruptSessionError,
  type EventLog,
  makeEventLog,
} from "./event_log.ts";
import { Kernel, KernelLive, makeKernel } from "./kernel.ts";
import { type EventBus, makeEventBus } from "./event_bus.ts";
import {
  bindSessionEnv,
  makeSessionManager,
  SessionManager,
  type SessionManagerInfra,
} from "./session.ts";
import { type DataPaths, dataPaths } from "./paths.ts";
import {
  makeAnthropicAdapter,
  makeOpenAIAdapter,
  makeResponsesAdapter,
  type ProviderAdapter,
  type ThinkingConfig,
} from "@niuma/provider";
import {
  ANTHROPIC_DEFAULT_BASE_URL,
  type NiumaConfig,
  niumaPaths,
  builtinBaseUrlFor,
  ConfigError,
  defaultModelRef,
  KIMI_PROVIDER_ID,
  loadMergedConfig,
  loadMergedMcpConfig,
  type McpConfig,
  readAuthFile,
  refreshKimiTokens,
  refreshTokens,
  resolveModelRef,
  substituteEnv,
} from "@niuma/config";
import { connectMcpServers, type McpServerHandle } from "@niuma/mcp";
import {
  MemoryPermissionEngine,
  type SubagentResult,
  ToolRegistry,
} from "@niuma/tools";
import { makeToolPipeline, runTurn } from "@niuma/agent";
import {
  kernelApprovalGateway,
  kernelEmitLive,
  kernelEventLog,
} from "./agent_deps.ts";
import { makeOAuthTokenSource } from "./oauth_source.ts";

export interface BootstrapDeps {
  readonly paths?: DataPaths;
  readonly event_log?: EventLog;
  readonly projection?: Projection;
  readonly bus?: EventBus;
  readonly infra?: Partial<SessionManagerInfra>;
  /** Pre-loaded config; tests/smoke inject this to skip the filesystem. */
  readonly config?: NiumaConfig;
  /** Pre-loaded MCP config; tests/smoke inject this to skip the filesystem
   * (defaults to {} whenever `config` is injected, mirroring it). */
  readonly mcpConfig?: McpConfig;
  /** Model ref (provider/model-id) the server binds to, overriding the
   * config's top-level `model`. The one-shot CLI passes its --model flag
   * (or the config default) through the tunnel so the provider adapter is
   * built for the provider the user actually picked. Ignored when
   * `deps.infra.provider` is injected (tests/smoke own the provider then). */
  readonly defaultModelRef?: string;
}

export interface BootstrapResult {
  readonly paths: DataPaths;
  readonly event_log: EventLog;
  readonly projection: Projection;
  readonly bus: EventBus;
  readonly infra: SessionManagerInfra;
  readonly config: NiumaConfig;
  /** Connected MCP servers (from the merged mcp.json levels). Callers that
   * own the process lifecycle may close() them on shutdown; the worker
   * exiting also reaps stdio subprocesses. */
  readonly mcpServers: ReadonlyArray<McpServerHandle>;
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

const validateEventLogs = async (
  eventLog: EventLog,
  projection: Projection,
): Promise<void> => {
  const sessionIds = await eventLog.listSessions();
  const sourceSessions = new Set(sessionIds);

  for (const sessionId of sessionIds) {
    try {
      for await (const _event of eventLog.replay(sessionId)) {
        // Validation happens before replay yields its first event.
      }
    } catch (error) {
      if (!(error instanceof CorruptSessionError)) throw error;
      sourceSessions.delete(sessionId);
      await projection.resetSession(sessionId);
    }
  }

  // The JSONL log is the source of truth. Derived rows without a source log
  // cannot describe a live session and are removed at startup.
  for (const session of await projection.listSessions()) {
    if (!sourceSessions.has(session.sessionId)) {
      await projection.resetSession(session.sessionId);
    }
  }
};

export const bootstrap = async (
  deps: BootstrapDeps = {},
): Promise<BootstrapResult> => {
  const paths = deps.paths ?? dataPaths();
  await Deno.mkdir(paths.root, { recursive: true });
  await Deno.mkdir(paths.sessions, { recursive: true });

  const projection = deps.projection ?? await ensureSchema(paths.db);
  const event_log = deps.event_log ??
    makeEventLog({
      sessionsDir: paths.sessions,
      onCorrupt: (sessionId) => projection.resetSession(sessionId),
    });
  await validateEventLogs(event_log, projection);
  const bus = deps.bus ?? await Effect.runPromise(makeEventBus());

  // ---- Configuration: config.toml + auth.json. ----
  // The provider package takes an explicit config; where it comes from is
  // resolved here, once, at boot. Tests/smoke inject `deps.config` and a
  // `deps.infra.provider` so neither the config file nor the network is
  // touched.
  //
  // The effective config is the global config.toml with project-level
  // .niuma/config.toml files (walked up from the workspace) merged on top — so
  // a project can pick its own default model or tune per-model limits without
  // restating provider credentials.
  const registry = new ToolRegistry();
  const workspace = envGet("NIUMA_WORKSPACE") ?? Deno.cwd();
  const config = deps.config ??
    await loadMergedConfig(niumaPaths().configFile, { projectDir: workspace });

  // ---- MCP servers (mcp.json: global < project .niuma/ dirs < workspace/.mcp.json). ----
  // Connected before the pipelines are built so their tools land in the one
  // registry shared by the parent session and subagents. Best-effort: a
  // server that won't connect is skipped with a warning, not fatal.
  const mcpConfig = deps.mcpConfig ??
    (deps.config !== undefined ? {} : await loadMergedMcpConfig({
      globalConfigDir: niumaPaths().config,
      workspace,
    }));
  const mcpServers = await connectMcpServers(mcpConfig);
  for (const handle of mcpServers) {
    for (const tool of handle.tools) registry.register(tool.name, tool);
  }

  // Build the kernel eagerly so the spawn_subagent closure below can capture
  // it. The Layer we hand downstream wraps the same value (Layer.succeed),
  // keeping a single kernel instance across the bootstrap + session layer.
  const kernel = await Effect.runPromise(
    makeKernel({ event_log, projection, bus }),
  );

  // ---- Agent infra: provider + tool pipeline. ----
  // makeOpenAIAdapter only touches the network on stream()/listModels(),
  // so constructing it here never fetches.
  const engine = new MemoryPermissionEngine({ cwd: workspace });

  // Default model: deps.defaultModelRef (the one-shot CLI's --model / config
  // default) wins, then the merged config's top-level `model`
  // (provider/model-id). A test/smoke may inject BOTH the provider and a
  // default model (e.g. the smoke harness pins "mock-model"); injecting a
  // provider alone still takes model + limits from the config so a mock
  // provider can be driven at realistic window sizes.
  const defaultRef = deps.defaultModelRef ?? config.model;
  let defaultModel = deps.infra?.defaultModel ?? "";
  let defaultContextWindow = deps.infra?.defaultContextWindow;
  let defaultMaxTokens = deps.infra?.defaultMaxTokens;
  let defaultThinking = deps.infra?.defaultThinking;
  let defaultProviderId = deps.infra?.defaultProviderId;
  if (defaultRef && !deps.infra?.defaultModel) {
    const resolved = resolveModelRef(config, defaultRef);
    defaultModel = resolved.modelId;
    defaultContextWindow = resolved.model.contextWindow;
    defaultMaxTokens = resolved.model.maxOutput;
    defaultThinking = thinkingFromModel(resolved.model);
    defaultProviderId = resolved.provider.id;
  }

  const provider = deps.infra?.provider !== undefined
    ? withDefaultModel(deps.infra.provider, defaultModel)
    : await makeProviderFromConfig(config, deps.defaultModelRef);

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
          event_log: kernelEventLog(kernel),
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
          ...(defaultThinking !== undefined
            ? { thinking: defaultThinking }
            : {}),
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => ({
              stopReason: "stop" as const,
              usage: { inputTokens: 0, outputTokens: 0 },
              text: `error: ${String(cause)}`,
            }))
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
    globalConfigDir: deps.infra?.globalConfigDir ?? niumaPaths().config,
    // Runtime model switching (SessionManager.setModel): the merged config
    // resolves provider/model-id refs, the factory rebuilds the adapter on a
    // cross-provider switch. Tests may inject both through deps.infra.
    config: deps.infra?.config ?? config,
    makeProvider: deps.infra?.makeProvider ?? makeProviderFromConfig,
    ...(defaultProviderId !== undefined ? { defaultProviderId } : {}),
    ...(defaultContextWindow !== undefined ? { defaultContextWindow } : {}),
    ...(defaultMaxTokens !== undefined ? { defaultMaxTokens } : {}),
    ...(defaultThinking !== undefined ? { defaultThinking } : {}),
  };

  // Wrap the eagerly-built kernel in a Layer so downstream consumers (the
  // session layer, the runtime built in createServerApp) all see the same
  // instance the spawn_subagent closure captured. The session layer binds
  // boot metadata (context window, MCP server status) onto the service as it
  // is built so the /sessions create response can surface it.
  const kernelLayer = Layer.succeed(Kernel, kernel);
  const sessionEnv = {
    ...(defaultContextWindow !== undefined
      ? { contextWindow: defaultContextWindow }
      : {}),
    mcpServers: mcpServers.map((s: McpServerHandle) => ({
      id: s.id,
      toolCount: s.tools.length,
    })),
  };
  const sessionLayer = Layer.effect(
    SessionManager,
    Effect.map(
      makeSessionManager(infra, sessionEnv),
      (sm) => bindSessionEnv(sm, sessionEnv),
    ),
  );

  return {
    paths,
    event_log,
    projection,
    bus,
    infra,
    config,
    mcpServers,
    kernelLayer,
    sessionLayer,
  };
};

/**
 * Rebind an injected adapter's fallback model (used when a ChatRequest omits
 * `model`) to the config-resolved default. Adapters are plain objects of
 * closures, so the rebind wraps rather than mutates. A no-op when no default
 * model was resolved (nothing configured).
 */
const withDefaultModel = (
  adapter: ProviderAdapter,
  defaultModel: string,
): ProviderAdapter =>
  defaultModel.length === 0 ? adapter : {
    listModels: adapter.listModels,
    stream: (req) =>
      adapter.stream({ ...req, model: req.model ?? defaultModel }),
  };

/**
 * Project a resolved ModelConfig's thinking fields into the provider-level
 * ThinkingConfig. Returns `undefined` when the model sets neither field, so
 * the caller's conditional spread omits the key entirely (no `thinking: {}`
 * no-op leaks into RunTurnDeps). Thinking is request-level, so this only
 * flows into ChatRequest — makeProviderFromConfig is untouched.
 */
const thinkingFromModel = (
  model: Readonly<{ thinkingEffort?: string; thinkingKeep?: "all" | "none" }>,
): ThinkingConfig | undefined => {
  if (
    model.thinkingEffort === undefined && model.thinkingKeep === undefined
  ) {
    return undefined;
  }
  return {
    ...(model.thinkingEffort !== undefined
      ? { effort: model.thinkingEffort }
      : {}),
    ...(model.thinkingKeep !== undefined ? { keep: model.thinkingKeep } : {}),
  };
};

/**
 * Build the provider adapter from config.toml + auth.json.
 *
 * The adapter is bound to the provider named by `ref` (defaults to the
 * config's top-level `model` reference; when neither is set, the unique
 * logged-in built-in provider's default model is used — that is what makes
 * `niuma auth login kimi|openai` work with zero config.toml). Credential
 * lookup is three-way:
 *   1. auth.json[<providerId>] of type "oauth" → an adapter with an injected
 *      OAuthTokenSource (oauth credentials apply to type="responses"
 *      providers — the ChatGPT lane — and to the built-in Kimi provider's
 *      type="openai" lane; any other pairing is a ConfigError).
 *   2. auth.json[<providerId>] of type "api" → the api key.
 *   3. provider api_key with {env:VAR} substitution (explicit escape hatch).
 * Missing credentials fail at boot with a pointer to both locations.
 *
 * Dispatch is driven by `provider.type` (default "openai"). Anthropic's
 * wire protocol has its own host — https://api.anthropic.com — independent
 * of the OpenAI-compatible defaults, so we substitute it whenever the
 * provider's table leaves baseUrl unset. Once the dispatch reaches the
 * adapter factory, the protocol-specific concerns (header shape, payload
 * schema, streaming) are the adapter's business; this file only knows the
 * labels and their default endpoints.
 *
 * `buildProvider` takes the auth path explicitly so tests do not need to
 * manipulate NIUMA_DATA_DIR; the exported `makeProviderFromConfig` fixes it to
 * niumaPaths().authFile (the public signature is unchanged).
 */
const buildProvider = async (
  config: NiumaConfig,
  authPath: string,
  ref?: string,
): Promise<ProviderAdapter> => {
  const auth = await readAuthFile(authPath);
  // ref → config.model → the unique logged-in built-in provider's default
  // (defaultModelRef returns undefined when zero or several built-ins have
  // credentials, which lands on the error below). The built-in default is
  // credential-kind aware (Kimi OAuth → subscription model; Kimi API key →
  // open-platform model).
  const modelRef = ref ?? config.model ??
    defaultModelRef((id) => auth[id]);
  if (!modelRef) {
    throw new ConfigError(
      `config: no default model set. Run \`niuma auth login <provider>\` for a ` +
        `built-in provider (kimi, openai), or add e.g.\n  model = "myprovider/my-model"` +
        `\nto ${niumaPaths().configFile}`,
    );
  }
  const resolved = resolveModelRef(config, modelRef);
  const providerType = resolved.provider.type ?? "openai";
  const entry = auth[resolved.provider.id];

  // OAuth credentials take an adapter with an injected token source. Two
  // lanes are legal:
  //   - type="responses" (the ChatGPT-subscription path, incl. the built-in
  //     openai provider): responses adapter + refreshTokens;
  //   - the built-in Kimi provider with type="openai" (kimi.com coding
  //     subscription): chat-completions adapter + refreshKimiTokens.
  // Any other pairing (e.g. oauth + anthropic, or oauth + a custom
  // chat-completions provider) is a configuration error, caught here so the
  // user sees a clear message instead of a silently-dropped credential.
  if (entry?.type === "oauth") {
    const tokenSource = (refresh: typeof refreshTokens) =>
      makeOAuthTokenSource({
        authPath,
        providerId: resolved.provider.id,
        entry,
        refresh,
      });
    if (providerType === "responses") {
      return makeResponsesAdapter({
        baseUrl: resolved.provider.baseUrl,
        defaultModel: resolved.modelId,
        auth: { kind: "oauth", tokenSource: tokenSource(refreshTokens) },
      });
    }
    if (
      providerType === "openai" && resolved.provider.id === KIMI_PROVIDER_ID
    ) {
      return makeOpenAIAdapter({
        baseUrl: resolved.provider.baseUrl,
        defaultModel: resolved.modelId,
        auth: { kind: "oauth", tokenSource: tokenSource(refreshKimiTokens) },
      });
    }
    throw new ConfigError(
      `config: oauth credentials for provider "${resolved.provider.id}" ` +
        `only apply to type="responses" providers or the built-in ` +
        `"${KIMI_PROVIDER_ID}" provider (got type="${providerType}"). ` +
        `Fix [provider.${resolved.provider.id}] in config.toml, or remove ` +
        `the oauth entry from ${authPath}.`,
    );
  }

  const apiKey = entry?.type === "api"
    ? entry.key
    : resolved.provider.apiKey !== undefined
    ? substituteEnv(resolved.provider.apiKey)
    : undefined;
  if (!apiKey) {
    throw new ConfigError(
      `config: no credentials for provider "${resolved.provider.id}". ` +
        `Run \`niuma auth login ${resolved.provider.id}\`, or add an entry to ` +
        `${authPath}:\n` +
        `  { "${resolved.provider.id}": { "type": "api", "key": "..." } }`,
    );
  }
  switch (providerType) {
    case "anthropic":
      // resolveModelRef already substitutes ANTHROPIC_DEFAULT_BASE_URL for a
      // base-url-less anthropic table; the ?? here is belt-and-braces for any
      // future caller that bypasses the resolver.
      return makeAnthropicAdapter({
        baseUrl: resolved.provider.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL,
        apiKey,
        defaultModel: resolved.modelId,
      });
    case "openai":
      return makeOpenAIAdapter({
        // Credential-kind-dependent endpoint for built-ins: a Kimi API key
        // targets the open platform (api.moonshot.cn); the subscription
        // endpoint is the OAuth lane. A user [provider.kimi] base_url
        // override always wins (builtinBaseUrlFor is the identity for every
        // other provider).
        baseUrl: builtinBaseUrlFor(
          resolved.provider.id,
          "api",
          resolved.provider.baseUrl,
          config.providers[resolved.provider.id]?.baseUrl,
        ),
        defaultModel: resolved.modelId,
        auth: { kind: "apiKey", key: apiKey },
      });
    case "responses":
      return makeResponsesAdapter({
        baseUrl: resolved.provider.baseUrl,
        defaultModel: resolved.modelId,
        auth: { kind: "apiKey", key: apiKey },
      });
    default:
      // Exhaustiveness guard: PROVIDER_TYPES is a closed set, but a future
      // addition must not silently fall through to undefined — fail loudly so
      // the dispatch stays total.
      throw new ConfigError(
        `config: provider "${resolved.provider.id}" has unsupported type ` +
          `"${providerType}" (expected one of openai, anthropic, responses).`,
      );
  }
};

/**
 * Build the provider adapter from config.toml + auth.json. Public entry point;
 * see {@link buildProvider} for the auth-path-injectable core used by tests.
 */
export const makeProviderFromConfig = (
  config: NiumaConfig,
  ref?: string,
): Promise<ProviderAdapter> => buildProvider(config, niumaPaths().authFile, ref);

export { buildProvider };

export { Kernel, KernelLive, SessionManager };
export { ensureSchema, makeProjection } from "./projection.ts";
export { makeEventLog } from "./event_log.ts";
export { makeEventBus } from "./event_bus.ts";
