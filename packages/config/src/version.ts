// Single source of truth for the app version: the "version" field of the
// workspace root deno.json. JSON modules are embedded at build time, so this
// also works in `deno compile` binaries without reading files at runtime.
import manifest from "../../../deno.json" with { type: "json" };

export const VERSION: string = manifest.version;
