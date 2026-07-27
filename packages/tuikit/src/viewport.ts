// ===========================================================================
// @niuma/tuikit — scrollable full-screen viewport
// ---------------------------------------------------------------------------
// Pure state/update/render helpers extracted from the original transcript.
// The caller still rebuilds its flat content list every frame; Viewport only
// owns clamping, follow-tail semantics and blank padding.
// ===========================================================================

import type { StyledLine } from "./binding_contract.ts";
import { blankLine, fitLine } from "./layout.ts";

export interface ViewportState {
  readonly offset: number;
  readonly followTail: boolean;
}

export type ViewportMsg =
  | { readonly type: "line-up"; readonly count?: number }
  | { readonly type: "line-down"; readonly count?: number }
  | { readonly type: "page-up" }
  | { readonly type: "page-down" }
  | { readonly type: "tail" }
  | { readonly type: "content-changed" };

export interface ViewportGeometry {
  readonly contentHeight: number;
  readonly height: number;
}

export const initialViewport = (): ViewportState => ({
  offset: 0,
  followTail: true,
});

const maxOffset = (geometry: ViewportGeometry): number =>
  Math.max(0, geometry.contentHeight - Math.max(0, geometry.height));

export const updateViewport = (
  state: ViewportState,
  msg: ViewportMsg,
  geometry: ViewportGeometry,
): ViewportState => {
  const max = maxOffset(geometry);
  if (msg.type === "tail") return { offset: max, followTail: true };
  if (msg.type === "content-changed") {
    return state.followTail
      ? { offset: max, followTail: true }
      : { ...state, offset: Math.min(state.offset, max) };
  }

  const page = Math.max(1, geometry.height - 1);
  const delta = msg.type === "page-up"
    ? -page
    : msg.type === "page-down"
    ? page
    : msg.type === "line-up"
    ? -(msg.count ?? 1)
    : msg.count ?? 1;
  const current = state.followTail ? max : state.offset;
  const offset = Math.max(0, Math.min(max, current + delta));
  return { offset, followTail: offset === max && delta > 0 };
};

export const renderViewport = (
  content: readonly StyledLine[],
  state: ViewportState,
  width: number,
  height: number,
): StyledLine[] => {
  const safeHeight = Math.max(0, height);
  const start = state.followTail
    ? Math.max(0, content.length - safeHeight)
    : Math.max(
      0,
      Math.min(
        state.offset,
        maxOffset({
          contentHeight: content.length,
          height: safeHeight,
        }),
      ),
    );
  const visible = content.slice(start, start + safeHeight)
    .map((line) => fitLine(line, width, true));
  while (visible.length < safeHeight) visible.push(blankLine(width));
  return visible;
};
