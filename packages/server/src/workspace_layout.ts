// WorkspaceLayout maps one normalized absolute Workspace path to the
// human-readable, Claude-style directory key used by both Session Journals
// and Usage Archives. It deliberately never hashes or realpaths the input.

import { join, resolve } from "@std/path";
import * as posix from "@std/path/posix";
import * as windows from "@std/path/windows";

export const WORKSPACE_LAYOUT_VERSION = 1;
export const WORKSPACE_IDENTITY_FILE = "workspace.json";

export type WorkspacePathStyle = "posix" | "windows";

export interface WorkspaceIdentity {
  readonly layoutVersion: typeof WORKSPACE_LAYOUT_VERSION;
  readonly path: string;
}

export interface WorkspaceLayout {
  readonly dataRoot: string;
  readonly workspace: string;
  readonly workspaceKey: string;
  readonly sessionsRoot: string;
  readonly usageRoot: string;
  readonly sessions: string;
  readonly usage: string;
  readonly identityFile: string;
}

export class WorkspaceKeyCollisionError extends Error {
  readonly expectedPath: string;
  readonly actualPath: string;
  readonly workspaceKey: string;

  constructor(
    workspaceKey: string,
    expectedPath: string,
    actualPath: string,
  ) {
    super(
      `workspace key ${workspaceKey} belongs to ${actualPath}, not ${expectedPath}`,
    );
    this.name = "WorkspaceKeyCollisionError";
    this.workspaceKey = workspaceKey;
    this.expectedPath = expectedPath;
    this.actualPath = actualPath;
  }
}

const pathStyle = (): WorkspacePathStyle =>
  Deno.build.os === "windows" ? "windows" : "posix";

export const workspaceKeyFromAbsolutePath = (
  absolutePath: string,
  style: WorkspacePathStyle = pathStyle(),
): string => {
  if (style === "posix") {
    if (!posix.isAbsolute(absolutePath)) {
      throw new Error(`workspace path must be absolute: ${absolutePath}`);
    }
    return posix.normalize(absolutePath).replaceAll("/", "-");
  }

  if (!windows.isAbsolute(absolutePath)) {
    throw new Error(`workspace path must be absolute: ${absolutePath}`);
  }
  const normalized = windows.normalize(absolutePath);
  if (normalized.startsWith("\\\\")) {
    const body = normalized.slice(2).replace(/[\\/]+/g, "-");
    return `-UNC-${body}`;
  }
  // A Windows drive colon cannot appear in a directory name on Windows.
  // `C:\Users\a` therefore becomes the equally readable `C-Users-a`.
  return normalized.replace(":", "").replace(/[\\/]+/g, "-");
};

export const makeWorkspaceLayout = (
  dataRoot: string,
  workspace: string,
): WorkspaceLayout => {
  const normalizedWorkspace = resolve(workspace);
  const workspaceKey = workspaceKeyFromAbsolutePath(normalizedWorkspace);
  const normalizedRoot = resolve(dataRoot);
  const sessionsRoot = join(normalizedRoot, "sessions");
  const usageRoot = join(normalizedRoot, "usage");
  const sessions = join(sessionsRoot, workspaceKey);
  const usage = join(usageRoot, workspaceKey);
  return {
    dataRoot: normalizedRoot,
    workspace: normalizedWorkspace,
    workspaceKey,
    sessionsRoot,
    usageRoot,
    sessions,
    usage,
    identityFile: join(sessions, WORKSPACE_IDENTITY_FILE),
  };
};

const parseIdentity = (text: string, path: string): WorkspaceIdentity => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new Error(`invalid workspace identity ${path}`, { cause });
  }
  if (
    typeof value !== "object" || value === null ||
    (value as Record<string, unknown>).layoutVersion !==
      WORKSPACE_LAYOUT_VERSION ||
    typeof (value as Record<string, unknown>).path !== "string"
  ) {
    throw new Error(`invalid workspace identity ${path}`);
  }
  return value as WorkspaceIdentity;
};

export const ensureWorkspaceLayout = async (
  layout: WorkspaceLayout,
): Promise<void> => {
  await Deno.mkdir(layout.sessions, { recursive: true });
  await Deno.mkdir(layout.usage, { recursive: true });

  const identity: WorkspaceIdentity = {
    layoutVersion: WORKSPACE_LAYOUT_VERSION,
    path: layout.workspace,
  };
  try {
    await Deno.writeTextFile(
      layout.identityFile,
      `${JSON.stringify(identity, null, 2)}\n`,
      { createNew: true },
    );
    return;
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
  }

  const existing = parseIdentity(
    await Deno.readTextFile(layout.identityFile),
    layout.identityFile,
  );
  if (existing.path !== layout.workspace) {
    throw new WorkspaceKeyCollisionError(
      layout.workspaceKey,
      layout.workspace,
      existing.path,
    );
  }
};
