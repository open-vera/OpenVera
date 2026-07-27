export interface TabBounds {
  id: string;
  /** Viewport-relative left edge. */
  left: number;
  width: number;
}

/**
 * Where a tab dropped at `clientX` should be inserted, as an index into the
 * pre-move array. Compares against each tab's midpoint, so hovering the left
 * half of a tab inserts before it.
 */
export function insertionIndexAt(bounds: TabBounds[], clientX: number): number {
  for (const [index, bound] of bounds.entries()) {
    if (clientX < bound.left + bound.width / 2) return index;
  }
  return bounds.length;
}

/**
 * Move the item at `fromIndex` so it lands at `insertionIndex`, where
 * `insertionIndex` counts positions in the array *before* the move. Returns the
 * original array when the move is a no-op or out of range.
 */
export function moveToInsertionIndex<T>(
  items: T[],
  fromIndex: number,
  insertionIndex: number,
): T[] {
  if (fromIndex < 0 || fromIndex >= items.length) return items;
  // Removing the dragged item shifts everything after it one slot left.
  const target = insertionIndex > fromIndex ? insertionIndex - 1 : insertionIndex;
  if (target === fromIndex || target < 0 || target >= items.length) return items;

  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(target, 0, moved);
  return next;
}

/** Same move, addressed by id. Returns the original array if the id is absent. */
export function moveTabById<T extends { id: string }>(
  items: T[],
  draggedId: string,
  insertionIndex: number,
): T[] {
  return moveToInsertionIndex(
    items,
    items.findIndex((item) => item.id === draggedId),
    insertionIndex,
  );
}

/**
 * Re-sort `current` to follow `desired`. Ids only in `current` keep their
 * relative order and are appended — persisted state may hold entries the
 * dragged group does not render.
 */
export function alignOrder(current: string[], desired: string[]): string[] {
  const known = new Set(current);
  const ordered = desired.filter((id) => known.has(id));
  const seen = new Set(ordered);
  return [...ordered, ...current.filter((id) => !seen.has(id))];
}
