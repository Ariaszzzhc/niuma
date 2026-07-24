import { Effect } from "effect";
import type { LiveEvent, Part, RecordedEvent } from "@niuma/schema";
import type { ProviderAdapter, ThinkingConfig } from "@niuma/provider";
import type {
  ApprovalGateway,
  EventLog,
  ToolMode,
  ToolPipeline,
} from "./deps.ts";
import { runTurn, type TurnResult } from "./loop.ts";

// Infrastructure shared by every session in a process.
export interface AgentInfra {
  readonly event_log: EventLog;
  readonly provider: ProviderAdapter;
  readonly tools: ToolPipeline;
  readonly approvals: ApprovalGateway;
  readonly defaultModel: string;
  readonly defaultContextWindow?: number;
  readonly defaultMaxTokens?: number;
  readonly defaultTemperature?: number;
  readonly defaultThinking?: ThinkingConfig;
  // Server-provided live sink (SSE). Events already carry sessionId.
  readonly emitLive?: (event: LiveEvent) => void;
}

export interface SessionOptions {
  readonly workspace: string;
  readonly model: string;
  readonly mode?: ToolMode;
  readonly depth?: number;
}

const SUBAGENT_DEPTH_LIMIT = 1;

const lastPlan = (events: ReadonlyArray<RecordedEvent>): unknown => {
  let plan: unknown;
  for (const ev of events) {
    if (ev.type === "tool.call.requested" && ev.data.name === "update_plan") {
      const input = ev.data.input as Record<string, unknown> | null;
      plan = input && typeof input === "object" ? input.plan ?? input : input;
    }
  }
  return plan;
};

export class AgentSession {
  readonly id: string;
  readonly workspace: string;
  readonly model: string;
  readonly mode: ToolMode;
  readonly depth: number;

  #steer: Part[][] = [];
  #abort = new AbortController();

  constructor(
    id: string,
    private readonly manager: SessionManager,
    private readonly infra: AgentInfra,
    opts: SessionOptions,
  ) {
    this.id = id;
    this.workspace = opts.workspace;
    this.model = opts.model;
    this.mode = opts.mode ?? "full";
    this.depth = opts.depth ?? 0;
  }

  // Queue additional user input to be folded in at the next loop top.
  steer(parts: ReadonlyArray<Part>): void {
    this.#steer.push([...parts]);
  }

  abort(): void {
    this.#abort.abort();
  }

  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  #deps() {
    return {
      event_log: this.infra.event_log,
      provider: this.infra.provider,
      tools: this.infra.tools,
      approvals: this.infra.approvals,
      model: this.model,
      workspace: this.workspace,
      mode: this.mode,
      ...(this.infra.defaultContextWindow !== undefined
        ? { contextWindow: this.infra.defaultContextWindow }
        : {}),
      ...(this.infra.defaultMaxTokens !== undefined
        ? { maxTokens: this.infra.defaultMaxTokens }
        : {}),
      ...(this.infra.defaultTemperature !== undefined
        ? { temperature: this.infra.defaultTemperature }
        : {}),
      ...(this.infra.defaultThinking !== undefined
        ? { thinking: this.infra.defaultThinking }
        : {}),
      signal: this.#abort.signal,
      ...(this.infra.emitLive ? { emitLive: this.infra.emitLive } : {}),
      drainInput: () => {
        const drained = this.#steer;
        this.#steer = [];
        return drained;
      },
    };
  }

  // Append a user message and run a turn to completion.
  prompt(parts: ReadonlyArray<Part>): Effect.Effect<TurnResult> {
    const { infra, id } = this;
    const deps = this.#deps();
    return Effect.gen(function* () {
      yield* infra.event_log.append(id, {
        type: "user.message",
        data: { parts: [...parts] },
      });
      return yield* runTurn(id, deps);
    });
  }

  // Resume the loop against the existing log without new input.
  run(): Effect.Effect<TurnResult> {
    return runTurn(this.id, this.#deps());
  }

  // Last known plan/TODO state from update_plan tool calls.
  plan(): Effect.Effect<unknown> {
    const { infra, id } = this;
    return Effect.gen(function* () {
      const events = yield* infra.event_log.replay(id);
      return lastPlan(events);
    });
  }

  // Spawn a child session, run it to completion, return its final text.
  // read-only mode drops mutating tools (enforced by the tool pipeline's defs).
  spawnSubagent(
    prompt: string,
    mode: ToolMode = "read-only",
  ): Effect.Effect<string> {
    const { depth, infra, id, manager, workspace, model } = this;
    return Effect.gen(function* () {
      if (depth >= SUBAGENT_DEPTH_LIMIT) {
        return "Subagent depth limit reached; cannot spawn further subagents.";
      }
      const child = manager.create({
        workspace,
        model,
        mode,
        depth: depth + 1,
      });
      yield* infra.event_log.append(child.id, {
        type: "session.created",
        data: { workspace, model },
      });
      yield* infra.event_log.append(id, {
        type: "subagent.spawned",
        data: {
          parentSessionId: id,
          childSessionId: child.id,
          prompt,
        },
      });
      const result = yield* child.prompt([{ type: "text", text: prompt }]);
      manager.remove(child.id);
      return result.text;
    });
  }
}

export class SessionManager {
  #sessions = new Map<string, AgentSession>();

  constructor(private readonly infra: AgentInfra) {}

  // Create a new live session (does NOT record session.created — the caller,
  // usually the server's create endpoint, records it after wiring the log).
  create(opts: {
    workspace: string;
    model?: string;
    mode?: ToolMode;
    depth?: number;
    id?: string;
  }): AgentSession {
    const id = opts.id ?? crypto.randomUUID();
    const session = new AgentSession(id, this, this.infra, {
      workspace: opts.workspace,
      model: opts.model ?? this.infra.defaultModel,
      ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
      ...(opts.depth !== undefined ? { depth: opts.depth } : {}),
    });
    this.#sessions.set(id, session);
    return session;
  }

  // Create a session and record session.created in one step.
  createAndRecord(opts: {
    workspace: string;
    model?: string;
  }): Effect.Effect<AgentSession> {
    const { infra } = this;
    const create = this.create.bind(this);
    return Effect.gen(function* () {
      const session = create(opts);
      yield* infra.event_log.append(session.id, {
        type: "session.created",
        data: { workspace: session.workspace, model: session.model },
      });
      return session;
    });
  }

  get(id: string): AgentSession | undefined {
    return this.#sessions.get(id);
  }

  remove(id: string): void {
    this.#sessions.delete(id);
  }

  replay(id: string): Effect.Effect<ReadonlyArray<RecordedEvent>> {
    return this.infra.event_log.replay(id);
  }

  // Rehydrate a session from its event log (reads workspace/model from the
  // session.created event) and register it as live.
  resume(id: string): Effect.Effect<AgentSession> {
    const { infra } = this;
    const get = this.get.bind(this);
    const create = this.create.bind(this);
    return Effect.gen(function* () {
      const existing = get(id);
      if (existing) return existing;
      const events = yield* infra.event_log.replay(id);
      const created = events.find((e) => e.type === "session.created");
      if (!created || created.type !== "session.created") {
        return yield* Effect.die(
          new Error(`session ${id} has no session.created event`),
        );
      }
      return create({
        id,
        workspace: created.data.workspace,
        model: created.data.model,
      });
    });
  }

  list(): ReadonlyArray<AgentSession> {
    return [...this.#sessions.values()];
  }
}
