// Directory layout for niuma:
//
//   user-level    = ~/.niuma — the single data root: config.toml, mcp.json,
//                   auth.json, log/, sessions/, niuma.db, tool-output spills
//   project-level = <workspace>/.niuma — config and resources only, NEVER
//                   data (sessions, db, logs live user-level only)
//
// When neither HOME nor USERPROFILE is set, the user-level root falls back
// to <cwd>/.niuma.
//
// Overrides:
//   NIUMA_DATA_DIR    — replaces the user-level root
//   NIUMA_CONFIG      — path to an explicit config.toml file
//
// Deno.env is read defensively: under --deny-env the getters throw, which
// must not take down path resolution.

import { join } from "@std/path";

const envGet = (name: string): string | undefined => {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
};

const home = (): string =>
  envGet("HOME") ?? envGet("USERPROFILE") ?? Deno.cwd();

export interface NiumaPaths {
  /** User-level data root: config.toml, mcp.json, sessions/, niuma.db. */
  readonly data: string;
  /** Root for user configuration — same as `data`. */
  readonly config: string;
  /** Log directory: <data>/log. */
  readonly log: string;
  /** Path to auth.json: <data>/auth.json. */
  readonly authFile: string;
  /** Path to the config file: NIUMA_CONFIG override or <data>/config.toml. */
  readonly configFile: string;
}

export const niumaPaths = (): NiumaPaths => {
  const override = envGet("NIUMA_DATA_DIR");
  const data = override && override.length > 0
    ? override
    : join(home(), ".niuma");
  return {
    data,
    config: data,
    log: join(data, "log"),
    authFile: join(data, "auth.json"),
    configFile: envGet("NIUMA_CONFIG") ?? join(data, "config.toml"),
  };
};
