// ===========================================================================
// @niuma/tuikit — selectable-list state
// ---------------------------------------------------------------------------
// Shared by completion, command palette, approval and question panels. Product
// components own their labels and colours; tuikit owns wrapping selection and
// the visible window around it.
// ===========================================================================

export interface SelectListState {
  readonly selected: number;
}

export interface SelectWindow {
  readonly start: number;
  readonly end: number;
  readonly selected: number;
}

export const initialSelectList = (): SelectListState => ({ selected: 0 });

export const moveSelection = (
  state: SelectListState,
  itemCount: number,
  delta: number,
): SelectListState => {
  if (itemCount <= 0) return { selected: 0 };
  return {
    selected: (state.selected + delta % itemCount + itemCount) % itemCount,
  };
};

export const clampSelection = (
  state: SelectListState,
  itemCount: number,
): SelectListState => ({
  selected: itemCount <= 0
    ? 0
    : Math.max(0, Math.min(state.selected, itemCount - 1)),
});

export const selectionWindow = (
  state: SelectListState,
  itemCount: number,
  maxVisible: number,
): SelectWindow => {
  const visible = Math.max(0, Math.min(itemCount, maxVisible));
  const selected = clampSelection(state, itemCount).selected;
  const start = visible === 0 ? 0 : Math.max(
    0,
    Math.min(
      selected - Math.floor(visible / 2),
      itemCount - visible,
    ),
  );
  return { start, end: start + visible, selected };
};
