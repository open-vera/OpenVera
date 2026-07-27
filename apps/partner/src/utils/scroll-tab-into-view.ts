export interface ScrollTabIntoViewOptions {
  edgePad?: number;
  behavior?: ScrollBehavior;
}

/**
 * Horizontally scroll `container` so the `[data-tab-id]` matching `tabId` is visible.
 * Returns true when a matching tab element was found.
 */
export function scrollTabIntoView(
  container: HTMLElement | null | undefined,
  tabId: string | null | undefined,
  options: ScrollTabIntoViewOptions = {},
): boolean {
  if (!container || !tabId) return false;

  const activeEl =
    Array.from(container.querySelectorAll<HTMLElement>("[data-tab-id]")).find(
      (el) => el.dataset.tabId === tabId,
    ) ?? null;
  if (!activeEl) return false;

  const edgePad = options.edgePad ?? 0;
  const behavior = options.behavior ?? "smooth";
  const containerRect = container.getBoundingClientRect();
  const tabRect = activeEl.getBoundingClientRect();

  if (tabRect.left < containerRect.left + edgePad) {
    container.scrollBy({
      left: tabRect.left - containerRect.left - edgePad,
      behavior,
    });
    return true;
  }

  if (tabRect.right > containerRect.right - edgePad) {
    container.scrollBy({
      left: tabRect.right - containerRect.right + edgePad,
      behavior,
    });
    return true;
  }

  return true;
}
