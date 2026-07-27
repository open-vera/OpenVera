/**
 * Tab reordering drag state.
 *
 * Tauri's native drag handling swallows HTML5 `drop` in this webview (see
 * `partner-dnd.ts`), so a reorder is committed on `dragend` by hit-testing the
 * release point instead of relying on a `drop` event firing.
 */
import { insertionIndexAt, type TabBounds } from "./tab-reorder.js";

/** Group id, mirrored in the DOM as `data-tab-group`. */
export type TabGroup = "center" | "preview";

export const TAB_REORDER_MIME = "application/x-partner-tab-reorder";

interface TabDragState {
  group: TabGroup;
  tabId: string;
}

let activeDrag: TabDragState | null = null;

export function beginTabDrag(
  group: TabGroup,
  tabId: string,
  dataTransfer?: DataTransfer | null,
): void {
  activeDrag = { group, tabId };
  // Some webviews refuse to start a drag with no payload attached.
  dataTransfer?.setData(TAB_REORDER_MIME, tabId);
}

export function activeTabDrag(): TabDragState | null {
  return activeDrag ? { ...activeDrag } : null;
}

export function clearTabDrag(): void {
  activeDrag = null;
}

/** Live bounds of every tab in a group, in DOM order. */
export function tabBoundsIn(group: TabGroup): TabBounds[] {
  const container = document.querySelector(`[data-tab-group="${group}"]`);
  if (!container) return [];
  return [...container.querySelectorAll<HTMLElement>("[data-tab-id]")].map((element) => {
    const rect = element.getBoundingClientRect();
    return { id: element.dataset.tabId ?? "", left: rect.left, width: rect.width };
  });
}

/**
 * Insertion index for a pointer position, or `null` when the point is outside
 * the group's tab strip (so callers can fall back to other drop behaviour).
 */
export function tabDropIndexAt(
  group: TabGroup,
  clientX: number,
  clientY: number,
): number | null {
  const container = document.querySelector(`[data-tab-group="${group}"]`);
  if (!container) return null;
  const rect = container.getBoundingClientRect();
  if (
    clientX < rect.left ||
    clientX > rect.right ||
    clientY < rect.top ||
    clientY > rect.bottom
  ) {
    return null;
  }
  return insertionIndexAt(tabBoundsIn(group), clientX);
}

/**
 * Resolve a reorder for the in-flight drag at a release point. Returns null
 * when there is no drag, the drag belongs to another group, or the release
 * landed outside the strip.
 */
export function resolveTabReorderAt(
  group: TabGroup,
  clientX: number,
  clientY: number,
): { tabId: string; insertionIndex: number } | null {
  if (!activeDrag || activeDrag.group !== group) return null;
  const insertionIndex = tabDropIndexAt(group, clientX, clientY);
  if (insertionIndex === null) return null;
  return { tabId: activeDrag.tabId, insertionIndex };
}
