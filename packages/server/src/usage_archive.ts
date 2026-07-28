// UsageArchive persists the content-free facts needed for long-term model
// analytics after a Session Journal expires. It is deliberately independent
// from Session replay: one strict JSONL file per Session, written atomically.

import { join } from "@std/path";
import type {
  BillingMode,
  ModelCallActor,
  ModelCallPurpose,
  RecordedEvent,
  StopReason,
  Usage,
} from "@niuma/schema";
import type { WorkspaceLayout } from "./workspace_layout.ts";

export const USAGE_ARCHIVE_VERSION = 1;

export interface UsageArchiveHeader {
  readonly type: "usage.archive";
  readonly version: typeof USAGE_ARCHIVE_VERSION;
  readonly sessionId: string;
  readonly workspace: string;
  readonly createdAt: number;
  readonly archivedAt: number;
}

export interface ArchivedUsageRecord {
  readonly type: "usage.record";
  readonly version: typeof USAGE_ARCHIVE_VERSION;
  readonly sourceSeq: number;
  readonly ts: number;
  readonly sessionId: string;
  readonly callId: string;
  readonly turnId: string;
  readonly purpose: ModelCallPurpose;
  readonly actor: ModelCallActor;
  readonly providerId: string;
  readonly modelId: string;
  readonly billingMode: BillingMode;
  readonly durationMs: number;
  readonly attempts: number;
  readonly outcome: "completed" | "failed";
  readonly finishReason?: StopReason;
  readonly usage: Usage;
}

export interface UsageArchiveFile {
  readonly header: UsageArchiveHeader;
  readonly records: ReadonlyArray<ArchivedUsageRecord>;
}

export interface ArchiveResult {
  readonly path: string;
  readonly recordCount: number;
  readonly created: boolean;
}

export interface UsageArchive {
  readonly archive: (
    sessionId: string,
    events: ReadonlyArray<RecordedEvent>,
  ) => Promise<ArchiveResult>;
  readonly read: (sessionId: string) => Promise<UsageArchiveFile | undefined>;
  readonly pathFor: (sessionId: string) => string;
}

export interface UsageArchiveOptions {
  readonly layout: WorkspaceLayout;
  readonly now?: () => number;
}

export class UsageArchiveConflictError extends Error {
  constructor(sessionId: string) {
    super(`Usage Archive conflicts with Session Journal ${sessionId}`);
    this.name = "UsageArchiveConflictError";
  }
}

export class CorruptUsageArchiveError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string, cause: unknown) {
    super(`corrupted Usage Archive deleted for session ${sessionId}`, {
      cause,
    });
    this.name = "CorruptUsageArchiveError";
    this.sessionId = sessionId;
  }
}

const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const PURPOSES = new Set(["agent", "compaction"]);
const ACTORS = new Set(["main", "subagent"]);
const BILLING_MODES = new Set(["subscription", "api", "unknown"]);
const STOP_REASONS = new Set([
  "stop",
  "length",
  "tool_calls",
  "content_filter",
  "abort",
  "error",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean => Object.keys(value).every((key) => allowed.has(key));

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isPositiveInt = (value: unknown): value is number =>
  isFiniteNumber(value) && Number.isSafeInteger(value) && value > 0;

const isTokenCount = (value: unknown): value is number | null =>
  value === null || (isFiniteNumber(value) && value >= 0);

const USAGE_KEYS = new Set([
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "cachedInputTokens",
  "cacheWriteTokens",
]);

const parseUsage = (value: unknown): Usage => {
  if (!isRecord(value) || !hasOnlyKeys(value, USAGE_KEYS)) {
    throw new Error("invalid archived usage");
  }
  const fields = [
    value.inputTokens,
    value.outputTokens,
    value.reasoningTokens,
    value.cachedInputTokens,
    value.cacheWriteTokens,
  ];
  if (!fields.every(isTokenCount)) throw new Error("invalid token count");
  return {
    inputTokens: value.inputTokens as number | null,
    outputTokens: value.outputTokens as number | null,
    reasoningTokens: value.reasoningTokens as number | null,
    cachedInputTokens: value.cachedInputTokens as number | null,
    cacheWriteTokens: value.cacheWriteTokens as number | null,
  };
};

const HEADER_KEYS = new Set([
  "type",
  "version",
  "sessionId",
  "workspace",
  "createdAt",
  "archivedAt",
]);

const parseHeader = (value: unknown): UsageArchiveHeader => {
  if (
    !isRecord(value) || !hasOnlyKeys(value, HEADER_KEYS) ||
    value.type !== "usage.archive" ||
    value.version !== USAGE_ARCHIVE_VERSION ||
    typeof value.sessionId !== "string" ||
    typeof value.workspace !== "string" ||
    !isFiniteNumber(value.createdAt) ||
    !isFiniteNumber(value.archivedAt)
  ) {
    throw new Error("invalid Usage Archive header");
  }
  return value as unknown as UsageArchiveHeader;
};

const RECORD_KEYS = new Set([
  "type",
  "version",
  "sourceSeq",
  "ts",
  "sessionId",
  "callId",
  "turnId",
  "purpose",
  "actor",
  "providerId",
  "modelId",
  "billingMode",
  "durationMs",
  "attempts",
  "outcome",
  "finishReason",
  "usage",
]);

const parseRecord = (value: unknown): ArchivedUsageRecord => {
  if (
    !isRecord(value) || !hasOnlyKeys(value, RECORD_KEYS) ||
    value.type !== "usage.record" ||
    value.version !== USAGE_ARCHIVE_VERSION ||
    !isPositiveInt(value.sourceSeq) ||
    !isFiniteNumber(value.ts) ||
    typeof value.sessionId !== "string" ||
    typeof value.callId !== "string" ||
    typeof value.turnId !== "string" ||
    typeof value.purpose !== "string" || !PURPOSES.has(value.purpose) ||
    typeof value.actor !== "string" || !ACTORS.has(value.actor) ||
    typeof value.providerId !== "string" ||
    typeof value.modelId !== "string" ||
    typeof value.billingMode !== "string" ||
    !BILLING_MODES.has(value.billingMode) ||
    !isFiniteNumber(value.durationMs) || value.durationMs < 0 ||
    !isPositiveInt(value.attempts) ||
    (value.outcome !== "completed" && value.outcome !== "failed") ||
    (value.finishReason !== undefined &&
      (typeof value.finishReason !== "string" ||
        !STOP_REASONS.has(value.finishReason))) ||
    (value.outcome === "completed" && value.finishReason === undefined) ||
    (value.outcome === "failed" && value.finishReason !== undefined)
  ) {
    throw new Error("invalid archived Usage Record");
  }
  return {
    ...(value as unknown as ArchivedUsageRecord),
    usage: parseUsage(value.usage),
  };
};

const parseArchiveText = (text: string): UsageArchiveFile => {
  if (!text.endsWith("\n")) throw new Error("truncated Usage Archive");
  const lines = text.slice(0, -1).split("\n");
  if (lines.length === 0 || lines[0].length === 0) {
    throw new Error("empty Usage Archive");
  }
  const parseLine = (line: string): unknown => {
    try {
      return JSON.parse(line);
    } catch (cause) {
      throw new Error("invalid Usage Archive JSON", { cause });
    }
  };
  const header = parseHeader(parseLine(lines[0]));
  const records = lines.slice(1).map((line) => parseRecord(parseLine(line)));
  const seen = new Set<string>();
  let previousSeq = 0;
  for (const record of records) {
    if (record.sessionId !== header.sessionId) {
      throw new Error("Usage Record belongs to another Session");
    }
    if (seen.has(record.callId)) {
      throw new Error(`duplicate Usage Record ${record.callId}`);
    }
    if (record.sourceSeq <= previousSeq) {
      throw new Error("Usage Records are not in Journal order");
    }
    seen.add(record.callId);
    previousSeq = record.sourceSeq;
  }
  return { header, records };
};

const unknownUsage = (): Usage => ({
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  cachedInputTokens: null,
  cacheWriteTokens: null,
});

const completeUsage = (usage: Usage): Usage => ({
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  reasoningTokens: usage.reasoningTokens ?? null,
  cachedInputTokens: usage.cachedInputTokens ?? null,
  cacheWriteTokens: usage.cacheWriteTokens ?? null,
});

const recordsFromEvents = (
  sessionId: string,
  events: ReadonlyArray<RecordedEvent>,
): ArchivedUsageRecord[] => {
  const records: ArchivedUsageRecord[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.sessionId !== sessionId) {
      throw new Error(`Session Journal contains event for ${event.sessionId}`);
    }
    if (
      event.type !== "model.call.completed" &&
      event.type !== "model.call.failed"
    ) {
      continue;
    }
    if (seen.has(event.data.callId)) {
      throw new Error(`duplicate Model Call ${event.data.callId}`);
    }
    seen.add(event.data.callId);
    const common = {
      type: "usage.record" as const,
      version: USAGE_ARCHIVE_VERSION as typeof USAGE_ARCHIVE_VERSION,
      sourceSeq: event.seq,
      ts: event.ts,
      sessionId,
      callId: event.data.callId,
      turnId: event.data.turnId,
      purpose: event.data.purpose,
      actor: event.data.actor,
      providerId: event.data.providerId,
      modelId: event.data.modelId,
      billingMode: event.data.billingMode,
      durationMs: event.data.durationMs,
      attempts: event.data.attempts,
    };
    records.push(
      event.type === "model.call.completed"
        ? {
          ...common,
          outcome: "completed",
          finishReason: event.data.finishReason,
          usage: completeUsage(event.data.usage),
        }
        : {
          ...common,
          outcome: "failed",
          usage: unknownUsage(),
        },
    );
  }
  return records;
};

const writeAll = async (
  file: Deno.FsFile,
  bytes: Uint8Array,
): Promise<void> => {
  let offset = 0;
  while (offset < bytes.length) {
    offset += await file.write(bytes.subarray(offset));
  }
};

const sameUsageRecord = (
  left: ArchivedUsageRecord,
  right: ArchivedUsageRecord,
): boolean => JSON.stringify(left) === JSON.stringify(right);

const isExactPrefix = (
  prefix: ReadonlyArray<ArchivedUsageRecord>,
  records: ReadonlyArray<ArchivedUsageRecord>,
): boolean =>
  prefix.length <= records.length &&
  prefix.every((record, index) => sameUsageRecord(record, records[index]!));

export const makeUsageArchive = (
  opts: UsageArchiveOptions,
): UsageArchive => {
  const { layout } = opts;
  const now = opts.now ?? (() => Date.now());

  const pathFor = (sessionId: string): string => {
    if (!SAFE_ID.test(sessionId)) {
      throw new Error(`unsafe sessionId: ${sessionId}`);
    }
    return join(layout.usage, `${sessionId}.jsonl`);
  };

  const read: UsageArchive["read"] = async (sessionId) => {
    const path = pathFor(sessionId);
    let text: string;
    try {
      text = await Deno.readTextFile(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    }
    try {
      const archive = parseArchiveText(text);
      if (
        archive.header.sessionId !== sessionId ||
        archive.header.workspace !== layout.workspace
      ) {
        throw new Error("Usage Archive identity does not match its path");
      }
      return archive;
    } catch (cause) {
      try {
        await Deno.remove(path);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      throw new CorruptUsageArchiveError(sessionId, cause);
    }
  };

  const writeArchiveFile = async (
    sessionId: string,
    archiveFile: UsageArchiveFile,
    replaceExisting: boolean,
  ): Promise<void> => {
    const destination = pathFor(sessionId);
    const text = [archiveFile.header, ...archiveFile.records]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n";
    await Deno.mkdir(layout.usage, { recursive: true });
    const temp = await Deno.makeTempFile({
      dir: layout.usage,
      prefix: `.${sessionId}-`,
      suffix: ".tmp",
    });
    try {
      const file = await Deno.open(temp, { write: true, truncate: true });
      try {
        await writeAll(file, new TextEncoder().encode(text));
        await file.sync();
      } finally {
        file.close();
      }
      try {
        await Deno.rename(temp, destination);
      } catch (error) {
        // POSIX rename replaces atomically. Windows can report AlreadyExists;
        // removing the old Archive is safe here because the complete Journal
        // still exists until this write is verified and Retention returns.
        if (
          !replaceExisting || !(error instanceof Deno.errors.AlreadyExists)
        ) {
          throw error;
        }
        await Deno.remove(destination);
        await Deno.rename(temp, destination);
      }
    } catch (error) {
      try {
        await Deno.remove(temp);
      } catch {
        // Best effort: an orphan temp file is never considered an archive.
      }
      throw error;
    }
  };

  const archive: UsageArchive["archive"] = async (sessionId, events) => {
    const created = events[0];
    if (
      created?.type !== "session.created" ||
      created.sessionId !== sessionId ||
      created.data.workspace !== layout.workspace
    ) {
      throw new Error(`invalid Session Journal for archive ${sessionId}`);
    }
    const records = recordsFromEvents(sessionId, events);
    let existing: UsageArchiveFile | undefined;
    try {
      existing = await read(sessionId);
    } catch (error) {
      if (!(error instanceof CorruptUsageArchiveError)) throw error;
      // The complete Journal is still present, so the derived Archive can be
      // recreated without loss.
      existing = undefined;
    }
    if (existing !== undefined) {
      const sameHeader = existing.header.sessionId === sessionId &&
        existing.header.workspace === layout.workspace &&
        existing.header.createdAt === created.ts;
      if (!sameHeader || !isExactPrefix(existing.records, records)) {
        throw new UsageArchiveConflictError(sessionId);
      }
      if (existing.records.length === records.length) {
        return {
          path: pathFor(sessionId),
          recordCount: records.length,
          created: false,
        };
      }
    }

    const header: UsageArchiveHeader = {
      type: "usage.archive",
      version: USAGE_ARCHIVE_VERSION,
      sessionId,
      workspace: layout.workspace,
      createdAt: created.ts,
      archivedAt: now(),
    };
    await writeArchiveFile(
      sessionId,
      { header, records },
      existing !== undefined,
    );
    // Read back the renamed file before Retention is allowed to delete the
    // Session Journal.
    const verified = await read(sessionId);
    if (
      verified === undefined ||
      verified.header.sessionId !== header.sessionId ||
      verified.header.workspace !== header.workspace ||
      verified.header.createdAt !== header.createdAt ||
      !isExactPrefix(verified.records, records) ||
      verified.records.length !== records.length
    ) {
      throw new Error(`failed to verify Usage Archive ${sessionId}`);
    }
    return {
      path: pathFor(sessionId),
      recordCount: records.length,
      created: existing === undefined,
    };
  };

  return { archive, read, pathFor };
};
