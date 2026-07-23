import { join } from "@std/path";
import { niumaPaths } from "@niuma/config";

export interface DataPaths {
  readonly root: string;
  readonly sessions: string;
  readonly db: string;
}

// The canonical root resolution (NIUMA_DATA_DIR override, ~/.niuma default,
// <cwd>/.niuma fallback) lives in packages/config/src/paths.ts.
export const defaultDataRoot = (): string => niumaPaths().data;

export const dataPaths = (root: string = defaultDataRoot()): DataPaths => ({
  root,
  sessions: join(root, "sessions"),
  db: join(root, "niuma.db"),
});
