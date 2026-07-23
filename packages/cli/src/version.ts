// CLI package version. Mirrors the version field in packages/cli/deno.json.
// Kept as a hard-coded constant so `niuma --version` works without reading the
// manifest at runtime (Deno does not expose import.meta's package.json).
export const CLI_VERSION = "0.0.0";
