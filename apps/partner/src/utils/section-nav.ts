export interface SectionOffset {
  id: string;
  /** Distance from the scroll container's top to the section's top edge. */
  top: number;
}

export interface PickActiveSectionOptions {
  /** How far below the viewport top a section must be to count as current. */
  anchorOffset?: number;
  /** Force the last section when the container is scrolled to its end. */
  atBottom?: boolean;
}

/**
 * Which section the reader is currently in, given a scroll position.
 *
 * The last section is often shorter than the viewport, so it can never reach
 * the anchor line by scrolling; `atBottom` covers that case.
 */
export function pickActiveSection(
  offsets: SectionOffset[],
  scrollTop: number,
  options: PickActiveSectionOptions = {},
): string {
  if (offsets.length === 0) return "";
  const { anchorOffset = 24, atBottom = false } = options;
  if (atBottom) return offsets[offsets.length - 1].id;

  const anchor = scrollTop + anchorOffset;
  let active = offsets[0].id;
  for (const offset of offsets) {
    if (offset.top <= anchor) active = offset.id;
    else break;
  }
  return active;
}

/** True when a scroll container cannot scroll any further down. */
export function isScrolledToBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  tolerance = 2,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= tolerance;
}
