export interface AnchoredMenuPosition {
  position: "fixed";
  left: string;
  /** Set when the menu opens below the anchor. */
  top?: string;
  /** Set when the menu opens above the anchor, so short content still hugs it. */
  bottom?: string;
  width: string;
  maxHeight: string;
  zIndex: string;
}

export interface PositionAnchoredMenuOptions {
  /** Preferred menu width in px. */
  width?: number;
  /** Preferred max height before viewport clamping. */
  preferredMaxHeight?: number;
  /** Minimum usable menu height. */
  minHeight?: number;
  gap?: number;
  viewportPad?: number;
  zIndex?: number;
  /**
   * Prefer opening above the anchor (chat composer is usually near the bottom).
   * Falls back to below when there is clearly more room underneath.
   */
  preferAbove?: boolean;
}

/**
 * Position a fixed popover next to an anchor so it stays fully inside the viewport.
 * Sets maxHeight to the available space so long lists scroll inside the menu
 * instead of overflowing under sibling UI (e.g. the composer card).
 */
export function positionAnchoredMenu(
  anchor: Pick<DOMRect, "left" | "right" | "top" | "bottom" | "width" | "height"> | null,
  viewport: Pick<Window, "innerWidth" | "innerHeight">,
  options: PositionAnchoredMenuOptions = {},
): AnchoredMenuPosition | Record<string, never> {
  if (!anchor) return {};

  const width = options.width ?? 260;
  const preferredMaxHeight = options.preferredMaxHeight ?? 320;
  const minHeight = options.minHeight ?? 160;
  const gap = options.gap ?? 8;
  const viewportPad = options.viewportPad ?? 12;
  const zIndex = options.zIndex ?? 200;
  const preferAbove = options.preferAbove ?? true;

  const left = Math.min(
    Math.max(viewportPad, anchor.left),
    Math.max(viewportPad, viewport.innerWidth - width - viewportPad),
  );

  const spaceAbove = Math.max(0, anchor.top - viewportPad - gap);
  const spaceBelow = Math.max(0, viewport.innerHeight - anchor.bottom - viewportPad - gap);
  const enough = Math.min(preferredMaxHeight, minHeight);
  // Prefer the requested side; flip only when that side is too small and the other is larger.
  const openAbove = preferAbove
    ? spaceAbove >= enough || spaceAbove >= spaceBelow
    : !(spaceBelow >= enough || spaceBelow >= spaceAbove);

  const available = Math.max(minHeight, openAbove ? spaceAbove : spaceBelow);
  const maxHeight = Math.min(preferredMaxHeight, available);

  if (openAbove) {
    // Anchor by the bottom edge: `maxHeight` is only a ceiling, so pinning `top`
    // would leave a gap between a short (all-collapsed) menu and its trigger.
    // Bottom anchoring means overflow would escape the top edge, so cap the
    // height at the real space above instead of the `minHeight` floor.
    return {
      position: "fixed",
      left: `${left}px`,
      bottom: `${Math.max(viewportPad, viewport.innerHeight - anchor.top + gap)}px`,
      width: `${width}px`,
      maxHeight: `${Math.min(maxHeight, spaceAbove) || maxHeight}px`,
      zIndex: `${zIndex}`,
    };
  }

  return {
    position: "fixed",
    left: `${left}px`,
    top: `${anchor.bottom + gap}px`,
    width: `${width}px`,
    maxHeight: `${maxHeight}px`,
    zIndex: `${zIndex}`,
  };
}
