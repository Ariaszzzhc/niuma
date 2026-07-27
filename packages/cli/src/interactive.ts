// Interactive TUI entrypoint.
//
// Mirrors one-shot main.ts's model resolution + worker bootstrap, then hands
// control to @niuma/tui's runTui (which owns the Terminal lifecycle, the TEA
// program, and the live session client). The worker is terminated in a finally
// so a leaked background fiber (SQLite projection / event bus) never outlives
// the process.
//
//   1. Native renderer guard: refuse early if the cdylib is missing.
//   2. Resolve the model (--model wins, else config.toml's top-level `model`).
//   3. setEnvIfAbsent NIUMA_WORKSPACE (inherited by the worker).
//   4. spawnServerWorker(): Worker + fetch tunnel + ready handshake.
//   5. runTui({ fetchImpl: tunnel.fetch, workspace, model, version }).
//   6. terminate the worker, return runTui's exit code.

import { runTui } from "@niuma/tui";
import {
  niumaPaths,
  loadMergedConfig,
  resolveModelRef,
  VERSION,
} from "@niuma/config";
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

  // Resolve the model exactly like one-shot main.ts: --model flag wins, else
  // config.toml's top-level `model` (provider/model-id). Validated here so a
  // typo fails fast with a config pointer instead of surfacing as a provider
  // 404 mid-turn.
  //
  //   - modelRef: raw provider/model-id ref, forwarded to the worker so its
  //     bootstrap binds the provider adapter to the provider the user
  //     actually picked.
  //   - model: bare model id recorded on the session. Undefined under the
  //     mock provider — the server falls back to the literal "default".
  let modelRef: string | undefined;
  let model: string | undefined;
  if (!mockProvider) {
    try {
      // Project-level .niuma/config.toml files merge over the global config.
      const config = await loadMergedConfig(niumaPaths().configFile, {
        projectDir: workspace,
      });
      const ref = args.model ?? config.model;
      if (!ref) {
        console.error(
          `niuma: no model configured. Set one with --model provider/model-id,` +
            ` or add e.g.\n  model = "myprovider/my-model"\nto ${niumaPaths().configFile}`,
        );
        return 1;
      }
      const resolved = resolveModelRef(config, ref);
      modelRef = ref;
      model = resolved.modelId;
    } catch (err) {
      console.error(
        `niuma: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
  }

  // Propagate the resolved workspace to the worker's bootstrap: the
  // permission engine reads NIUMA_WORKSPACE at startup to set its cwd.
  // Workers snapshot the parent env at spawn time, so this is inherited.
  setEnvIfAbsent("NIUMA_WORKSPACE", workspace);

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
      ...(model !== undefined ? { model } : {}),
      version: VERSION,
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
    // Ask the worker to dispose its runtime, MCP transports, and projection
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

const setEnvIfAbsent = (name: string, value: string): void => {
  if (!Deno.env.get(name)) {
    try {
      Deno.env.set(name, value);
    } catch {
      // Best-effort; ignore if env is not writable.
    }
  }
};
