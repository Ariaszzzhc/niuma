import { niumaPaths } from "@niuma/config";
import {
  makeWorkspaceLayout,
  type WorkspaceLayout,
} from "./workspace_layout.ts";

export interface DataPaths extends WorkspaceLayout {
  readonly root: string;
}

// The canonical root resolution (NIUMA_DATA_DIR override, ~/.niuma default,
// <cwd>/.niuma fallback) lives in packages/config/src/paths.ts.
export const defaultDataRoot = (): string => niumaPaths().data;

export const dataPaths = (
  root: string = defaultDataRoot(),
  workspace: string = Deno.cwd(),
): DataPaths => ({
  root,
  ...makeWorkspaceLayout(root, workspace),
});
