// XDG directory layout for niuma, following opencode's convention
// (packages/core/src/global.ts):
//
//   data   = $XDG_DATA_HOME/niuma   (~/.local/share/niuma)  — auth.json, log/,
//          mutable user data owned by the app
//   config = $XDG_CONFIG_HOME/niuma (~/.config/niuma)       — config.toml,
//          plus the session event logs / sqlite projection that predate the
//          config split (migrating those is out of scope for this change)
//
// Overrides:
//   NIUMA_DATA_DIR    — replaces BOTH roots (the historical single-root
//                      layout the store/tools packages already honour)
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
  /** Root for mutable app data (auth.json, log/). */
  readonly data: string;
  /** Root for user configuration (config.toml). */
  readonly config: string;
  /** Log directory: <data>/log. */
  readonly log: string;
  /** Path to auth.json: <data>/auth.json. */
  readonly authFile: string;
  /** Path to the config file: NIUMA_CONFIG override or <config>/config.toml. */
  readonly configFile: string;
}

export const niumaPaths = (): NiumaPaths => {
  const override = envGet("NIUMA_DATA_DIR");
  const data = override && override.length > 0
    ? override
    : join(envGet("XDG_DATA_HOME") ?? join(home(), ".local", "share"), "niuma");
  const config = override && override.length > 0
    ? override
    : join(envGet("XDG_CONFIG_HOME") ?? join(home(), ".config"), "niuma");
  return {
    data,
    config,
    log: join(data, "log"),
    authFile: join(data, "auth.json"),
    configFile: envGet("NIUMA_CONFIG") ?? join(config, "config.toml"),
  };
};
