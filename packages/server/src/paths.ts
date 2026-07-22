import { join } from "@std/path";

export interface DataPaths {
  readonly root: string;
  readonly sessions: string;
  readonly db: string;
}

const envGet = (name: string): string | undefined => {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
};

export const defaultDataRoot = (): string => {
  const override = envGet("NIUMA_DATA_DIR");
  if (override && override.length > 0) return override;
  const home = envGet("HOME");
  if (!home) return join(Deno.cwd(), ".niuma");
  return join(home, ".config", "niuma");
};

export const dataPaths = (root: string = defaultDataRoot()): DataPaths => ({
  root,
  sessions: join(root, "sessions"),
  db: join(root, "niuma.db"),
});