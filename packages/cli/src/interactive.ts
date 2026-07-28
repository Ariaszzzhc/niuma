// Interactive TUI entrypoint.
//
// Mirrors one-shot main.ts's Server Worker bootstrap, then hands
// control to @niuma/tui's runTui (which owns the Terminal lifecycle, the TEA
// program, and the live session client). The worker is terminated in a finally
// so a leaked background fiber or event bus never outlives the process.
//
//   1. Native renderer guard: refuse early if the cdylib is missing.
//   2. Forward the raw --model override to the Server Worker.
//   3. Set NIUMA_WORKSPACE to the selected Workspace (inherited by the worker).
//   4. spawnServerWorker(): Worker + fetch tunnel + ready handshake.
//   5. runTui({ fetchImpl: tunnel.fetch, workspace, version }).
//   6. terminate the worker, return runTui's exit code.

import { runTui } from "@niuma/tui";
import { VERSION } from "@niuma/config";
import { fromFileUrl } from "@std/path";
import { spawnServerWorker } from "./worker.ts";
import type { InteractiveArgs } from "./args.ts";

// ---------------------------------------------------------------------------
// Native renderer guard
// ---------------------------------------------------------------------------

/**
 * Compiled cdylib filename. Mirrors `@niuma/tuikit`'s `ffi.ts` — Cargo
 * prefixes the crate name with `lib` on Unix targets but not on Windows —
 * so the pre-check looks for exactly the artifact `openLib()` would dlopen.
 */
const nativeLibFileName = (): string => {
  switch (Deno.build.os) {
    case "darwin":
      return "libniuma_tuikit.dylib";
    case "windows":
      return "niuma_tuikit.dll";
    default:
      return "libniuma_tuikit.so";
  }
};

/**
 * True when the release cdylib is absent. Resolves the same path
 * `@niuma/tuikit`'s `libPath()` does (`packages/tuikit/native/target/release/
 * <platform cdylib filename>`), relative to this module. Checked up front so a
 * missing build surfaces the actionable fix instead of a raw dlopen fault
 * from inside `runTui` (which catches and rewrites every error).
 */
const nativeLibMissing = (): boolean => {
  const libUrl = new URL(
    `../../tuikit/native/target/release/${nativeLibFileName()}`,
    import.meta.url,
  );
  try {
    return Deno.statSync(fromFileUrl(libUrl)).isFile !== true;
  } catch {
    return true;
  }
};

// ---------------------------------------------------------------------------
// runInteractive
// ---------------------------------------------------------------------------

export const runInteractive = async (
  args: InteractiveArgs,
): Promise<number> => {
  // Native renderer guard. The TUI cannot run without the cdylib; fail fast
  // with the build command before opening a terminal / spawning a worker.
  if (nativeLibMissing()) {
    console.error(
      "niuma: TUI needs the native renderer — run: deno task build:native",
    );
    return 1;
  }

  const { workspace, mockProvider } = args;

  // The TUI is a Client and never reads config.toml. The Server Worker owns
  // effective config resolution and validates this optional raw override.
  const modelRef = mockProvider ? undefined : args.model;

  // Propagate the resolved workspace to the worker's bootstrap: the
  // permission engine reads NIUMA_WORKSPACE at startup to set its cwd.
  // Workers snapshot the parent env at spawn time, so this is inherited.
  setWorkspaceEnv(workspace);

  const spawned = await spawnServerWorker({
    mockProvider,
    ...(modelRef !== undefined ? { modelRef } : {}),
  });
  if (!spawned.ok) {
    return spawned.exitCode;
  }
  const { tunnel } = spawned;

  try {
    return await runTui({
      fetchImpl: tunnel.fetch,
      workspace,
      version: VERSION,
      ...(modelRef !== undefined ? { model: modelRef } : {}),
      ...(args.resume !== undefined ? { resume: args.resume } : {}),
    });
  } catch (err) {
    // The native-missing case is handled by the guard above; anything that
    // escapes runTui here is a different fault. Surface it verbatim rather
    // than masking it as a build instruction.
    console.error(
      `niuma: tui failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  } finally {
    // Ask the worker to dispose its runtime, MCP transports, and event bus
    // before terminating the isolate.
    try {
      await tunnel.close();
    } catch {
      // The hard termination below remains the final safety net.
    }
    try {
      tunnel.worker.terminate();
    } catch {
      // ignore
    }
  }
};

const setWorkspaceEnv = (workspace: string): void => {
  try {
    // An explicit/default CLI Workspace is authoritative for this process.
    // A stale inherited NIUMA_WORKSPACE must never redirect Session storage.
    Deno.env.set("NIUMA_WORKSPACE", workspace);
  } catch {
    // Best-effort; bootstrap still falls back to its process cwd.
  }
};
