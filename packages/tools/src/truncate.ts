import { join } from "@std/path";
import { ensureDirSync } from "@std/fs/ensure-dir";
import { niumaPaths } from "@niuma/config";

const OUTPUT_LIMIT_BYTES = 30 * 1024;
const OUTPUT_DIR = "output";

let _resolvedRoot: string | null = null;

/** ~/.niuma — the user-level data root (niumaPaths().data). */
export function dataDir(): string {
  if (_resolvedRoot) return _resolvedRoot;
  const root = niumaPaths().data;
  ensureDirSync(root);
  _resolvedRoot = root;
  return root;
}

export function outputDir(): string {
  const dir = join(dataDir(), OUTPUT_DIR);
  ensureDirSync(dir);
  return dir;
}

export interface TruncateResult {
  content: string;
  spillPath?: string;
  truncated: boolean;
}

/**
 * Sanitise an arbitrary callId (which often contains user input — file
 * paths, regex patterns, shell snippets) into a filename-safe string. We
 * replace path separators and a few other shell-meaningful characters with
 * `_` and trim length so the spill file can always be written regardless of
 * what the tool was invoked with.
 */
export function safeCallId(callId: string): string {
  const cleaned = callId.replace(/[^A-Za-z0-9._-]+/g, "_").replace(
    /^[_.-]+|[_.-]+$/g,
    "",
  );
  const base = cleaned.length > 0 ? cleaned : "call";
  // Cap length to keep filesystems happy (255 bytes is typical).
  return base.length > 128 ? base.slice(0, 128) : base;
}

/**
 * Cap `text` at 30 KiB. Anything past the cap is written to
 * ~/.niuma/output/<callId>.log and the returned `content` is
 * annotated with a `[truncated, full at <spillPath>]` line so the model can
 * still see a hint without paying the token cost.
 */
export async function truncateForModel(
  text: string,
  callId: string,
): Promise<TruncateResult> {
  const enc = new TextEncoder().encode(text);
  if (enc.byteLength <= OUTPUT_LIMIT_BYTES) {
    return { content: text, truncated: false };
  }

  const spillPath = join(outputDir(), `${safeCallId(callId)}.log`);
  await Deno.writeTextFile(spillPath, text);

  // Keep the head and a tail sample so the model can still locate context,
  // but the bulk is in the spill file. We bias toward the head (more useful
  // for grep/cat-style output) and trim the rest to a single hint line.
  const headBytes = Math.floor(OUTPUT_LIMIT_BYTES * 0.7);
  const headText = new TextDecoder().decode(enc.subarray(0, headBytes));
  const tailText = new TextDecoder().decode(
    enc.subarray(enc.byteLength - (OUTPUT_LIMIT_BYTES - headBytes)),
  );
  const content =
    `${headText}\n…[truncated; full output at ${spillPath}; byteLength=${enc.byteLength}]…\n${tailText}`;
  return { content, spillPath, truncated: true };
}

/**
 * Convenience wrapper that produces a `ToolOutput` value with truncation
 * handled automatically.
 */
export async function toolOutput(
  text: string,
  callId: string,
  opts: { isError?: boolean } = {},
): Promise<import("./types.ts").ToolOutput> {
  const { content, spillPath, truncated } = await truncateForModel(
    text,
    callId,
  );
  return {
    content,
    callId,
    ...(truncated ? { spillPath } : {}),
    ...(opts.isError ? { isError: true } : {}),
  };
}
