/**
 * Tab reordering, driven entirely by pointer events.
 *
 * HTML5 drag-and-drop cannot carry this: the tab strips are `<button>` elements
 * and WebKit refuses to start a drag on form controls, while webviews that *do*
 * start one cancel the pointer stream mid-gesture. Neither event model completes
 * a reorder on its own, so the tabs set no `draggable` attribute at all and this
 * module reads the geometry directly.
 */
import { insertionIndexAt, type TabBounds } from "./tab-reorder.js";

/** Group id, mirrored in the DOM as `data-tab-group`. */
export type TabGroup = "center" | "preview";

/** Pointer travel before a press turns into a reorder rather than a click. */
const DRAG_THRESHOLD_PX = 4;
/** Vertical slack around the strip when committing a pointer drag. */
const POINTER_DROP_SLACK_Y = 48;

interface TabDragState {
  group: TabGroup;
  tabId: string;
}

let activeDrag: TabDragState | null = null;

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
  return [...container.querySelectorAll<HTMLElement>("[data-tab-id]")].map(
    (element) => {
    const rect = element.getBoundingClientRect();
      return {
        id: element.dataset.tabId ?? "",
        left: rect.left,
        width: rect.width,
      };
}
  );
}

/**
 * Insertion index for a pointer position, or `null` when the pointer has drifted
 * too far from the strip. Tolerant of vertical drift and of dragging past either
 * end — pointer drags are freehand, so a release just below the tabs still means
 * "drop here", while a release near the composer must not reorder.
 */
export function tabDropIndexNear(
  group: TabGroup,
  clientX: number,
  clientY: number,
  slackY = POINTER_DROP_SLACK_Y
): number | null {
  const container = document.querySelector(`[data-tab-group="${group}"]`);
  if (!container) return null;
  const rect = container.getBoundingClientRect();
  if (clientY < rect.top - slackY || clientY > rect.bottom + slackY)
    return null;
  // insertionIndexAt already clamps: before the first tab → 0, past the last → length.
  return insertionIndexAt(tabBoundsIn(group), clientX);
}

export interface PointerTabDragHandlers {
  /** Live insertion marker; null while below the drag threshold or off-strip. */
  onPreview: (insertionIndex: number | null) => void;
  onCommit: (insertionIndex: number) => void;
  /** Released outside the strip — the caller may run its own drop behaviour. */
  onDropOutside?: (clientX: number, clientY: number) => void;
}

/**
 * Pointer-driven reorder.
 *
 * The tab strips deliberately do *not* set `draggable`: WebKit refuses to start
 * an HTML5 drag on form controls (both strips are `<button>`s), and when it does
 * engage a native drag session it cancels the pointer stream, so neither event
 * model completes a reorder. Pointer events alone work in every webview and
 * survive Tauri's native drag interception.
 */
export function startPointerTabDrag(
  group: TabGroup,
  tabId: string,
  event: PointerEvent,
  handlers: PointerTabDragHandlers
): void {
  if (event.button !== 0) return;
  const element = event.currentTarget as HTMLElement | null;
  const startX = event.clientX;
  const startY = event.clientY;
  let dragging = false;
  let lastIndex: number | null = null;
  let lastX = startX;
  let lastY = startY;

  const finish = (commit: boolean) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKeyDown);
    if (element?.hasPointerCapture?.(event.pointerId)) {
      element.releasePointerCapture(event.pointerId);
}
    handlers.onPreview(null);
    const wasDragging = dragging;
    dragging = false;
    if (wasDragging) clearTabDrag();
    if (!commit || !wasDragging) return;
    if (lastIndex !== null) handlers.onCommit(lastIndex);
    else handlers.onDropOutside?.(lastX, lastY);
  };

  function onMove(move: PointerEvent) {
    lastX = move.clientX;
    lastY = move.clientY;
    if (!dragging) {
      if (
        Math.abs(move.clientX - startX) < DRAG_THRESHOLD_PX &&
        Math.abs(move.clientY - startY) < DRAG_THRESHOLD_PX
      ) {
        return;
      }
      dragging = true;
      activeDrag = { group, tabId };
      element?.setPointerCapture?.(event.pointerId);
    }
    lastIndex = tabDropIndexNear(group, move.clientX, move.clientY);
    handlers.onPreview(lastIndex);
  }

  function onUp(up: PointerEvent) {
    lastX = up.clientX ?? lastX;
    lastY = up.clientY ?? lastY;
    finish(true);
  }

  function onCancel() {
    finish(false);
  }

  function onKeyDown(key: KeyboardEvent) {
    if (key.key === "Escape") finish(false);
  }

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("keydown", onKeyDown);
}
