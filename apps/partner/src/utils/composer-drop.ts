/** Bridge OS / internal path drops into the active chat composer. */

type PathDropHandler = (paths: string[]) => void;
type HoverHandler = (active: boolean) => void;

let pathDropHandler: PathDropHandler | null = null;
let hoverHandler: HoverHandler | null = null;

export function setComposerPathDropHandler(handler: PathDropHandler | null): void {
  pathDropHandler = handler;
}

export function setComposerDropHoverHandler(handler: HoverHandler | null): void {
  hoverHandler = handler;
}

export function setNativeFileDropHover(active: boolean): void {
  hoverHandler?.(active);
}

export function deliverComposerPathDrop(paths: string[]): boolean {
  const cleaned = Array.from(new Set(paths.map((path) => path.trim()).filter(Boolean)));
  if (!cleaned.length || !pathDropHandler) return false;
  pathDropHandler(cleaned);
  return true;
}
