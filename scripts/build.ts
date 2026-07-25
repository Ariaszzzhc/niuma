// Build pipeline: compile the niuma CLI into a single-file executable with
// `deno compile`.
//
// What this does:
//   1. Builds the native tuikit cdylib (cargo build --release) unless
//      --skip-native or a foreign --target is given.
//   2. Runs `deno compile` on packages/cli/src/main.ts with the two required
//      --include entries:
//        - packages/cli/src/server_worker.ts — Deno does NOT auto-embed
//          workers spawned as `new Worker(new URL(..., import.meta.url))`;
//          without it the binary fails at runtime with "Module not found:
//          .../deno-compile-niuma/packages/cli/src/server_worker.ts".
//        - the native cdylib — ffi.ts resolves it relative to import.meta.url,
//          which maps onto the embedded VFS, so dlopen keeps working in the
//          compiled binary. Missing artifact -> warn and continue (one-shot /
//          serve modes don't touch FFI; the TUI fails at first FFI call with
//          an actionable error, same as running from source without the lib).
//   3. Smoke-verifies the binary: a mock-provider one-shot run in an isolated
//      temp workspace + NIUMA_DATA_DIR (network-free), asserting exit 0 and
//      the scripted "smoke done" output.
//
// Flags: `--allow-all` and `--unstable-worker-options` are baked into the
// binary at compile time (the worker's `deno: { permissions: "inherit" }`
// needs the latter).
//
// Cross-compilation: `--target <triple>` is forwarded to `deno compile`. The
// JS side cross-compiles fine, but the cdylib must match the TARGET platform —
// this script only maps the target to the right artifact filename and expects
// a matching cdylib to already sit in packages/tuikit/native/target/release/.
//
// Run: `deno task build [-- --target <triple>] [-- --skip-native]`

import { fromFileUrl, join } from "@std/path";

const ROOT = fromFileUrl(new URL("..", import.meta.url));
const DECODER = new TextDecoder();

interface BuildOpts {
  readonly target?: string;
  readonly skipNative: boolean;
}

const fail = (phase: string, message: string): never => {
  throw new Error(`[build:${phase}] ${message}`);
};

const parseArgs = (args: string[]): BuildOpts => {
  let target: string | undefined;
  let skipNative = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--target") {
      target = args[++i];
      if (!target) fail("args", "--target requires a value");
    } else if (arg === "--skip-native") {
      skipNative = true;
    } else {
      fail("args", `unknown argument: ${arg}`);
    }
  }
  return { ...(target !== undefined ? { target } : {}), skipNative };
};

/** The OS the compiled binary will run on, derived from --target or the host. */
const targetOs = (target: string | undefined): string => {
  if (!target) return Deno.build.os;
  if (target.includes("windows")) return "windows";
  if (target.includes("apple-darwin")) return "darwin";
  return "linux";
};

/** Same mapping as packages/tuikit/src/ffi.ts `libFileName()`. */
const libFileName = (os: string): string => {
  switch (os) {
    case "darwin":
      return "libniuma_tuikit.dylib";
    case "windows":
      return "niuma_tuikit.dll";
    default:
      return "libniuma_tuikit.so";
  }
};

const run = async (
  cmd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> => {
  console.error(`[build] $ ${cmd} ${args.join(" ")}`);
  const output = await new Deno.Command(cmd, {
    args,
    cwd: ROOT,
    env: env ? { ...Deno.env.toObject(), ...env } : undefined,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: DECODER.decode(output.stdout),
    stderr: DECODER.decode(output.stderr),
  };
};

const main = async (): Promise<void> => {
  const opts = parseArgs(Deno.args);
  const os = targetOs(opts.target);
  const cross = opts.target !== undefined && os !== Deno.build.os;

  // ---- 1. Native cdylib. ----
  if (opts.skipNative || cross) {
    if (cross) {
      console.error(
        `[build] cross target ${opts.target}: skipping host cargo build; ` +
          `a ${os} cdylib must already be in packages/tuikit/native/target/release/`,
      );
    }
  } else {
    const cargo = await run("deno", ["task", "build:native"]);
    if (cargo.code !== 0) {
      fail("native", `cargo build failed:\n${cargo.stderr}`);
    }
  }

  // ---- 2. deno compile. ----
  const libPath = join(
    ROOT,
    "packages",
    "tuikit",
    "native",
    "target",
    "release",
    libFileName(os),
  );
  const includes = ["packages/cli/src/server_worker.ts"];
  try {
    if ((await Deno.stat(libPath)).isFile) {
      includes.push(libPath);
    }
  } catch {
    console.error(
      `[build] warning: native library not found at ${libPath}; ` +
        `compiling without it (TUI will fail at first FFI call)`,
    );
  }

  const outName = os === "windows" ? "niuma.exe" : "niuma";
  const outPath = join(ROOT, "dist", outName);
  const compileArgs = [
    "compile",
    "--allow-all",
    "--unstable-worker-options",
    ...includes.flatMap((i) => ["--include", i]),
    ...(opts.target ? ["--target", opts.target] : []),
    "--output",
    outPath,
    "packages/cli/src/main.ts",
  ];
  const compiled = await run("deno", compileArgs);
  if (compiled.code !== 0) {
    fail("compile", `deno compile failed:\n${compiled.stderr}`);
  }
  console.error(`[build] compiled: ${outPath}`);

  // ---- 3. Smoke-verify the binary (skip when cross-compiling). ----
  if (cross) {
    console.error("[build] cross target: skipping binary smoke run");
    return;
  }
  const dataDir = await Deno.makeTempDir({ prefix: "niuma-build-data-" });
  const workspace = await Deno.makeTempDir({ prefix: "niuma-build-ws-" });
  try {
    const smoke = await run(
      outPath,
      ["-p", "hi", "--workspace", workspace, "--mock-provider"],
      { NIUMA_DATA_DIR: dataDir },
    );
    if (smoke.code !== 0 || !smoke.stdout.includes("smoke done")) {
      fail(
        "smoke",
        `binary smoke failed (exit ${smoke.code}):\n${smoke.stdout}\n${smoke.stderr}`,
      );
    }
    console.error("[build] binary smoke: PASS");
  } finally {
    await Deno.remove(dataDir, { recursive: true }).catch(() => {});
    await Deno.remove(workspace, { recursive: true }).catch(() => {});
  }
};

if (import.meta.main) {
  await main();
}
