/** MIME / clipboard payload helpers for Partner drag-drop and selection refs. */

export const PARTNER_PATHS_MIME = "application/x-partner-paths";
export const PARTNER_SELECTION_MIME = "application/x-partner-selection";

export interface PartnerPathDragItem {
  path: string;
  isDir: boolean;
}

export interface PartnerSelectionPayload {
  path: string;
  name: string;
  content: string;
  startLine: number;
  endLine: number;
}

let lastSelection: PartnerSelectionPayload | null = null;
/** In-flight HTML5 partner drag (Tauri may swallow DOM drop; finish on dragend). */
let activePartnerDrag: PartnerPathDragItem[] | null = null;

export function rememberPartnerSelection(payload: PartnerSelectionPayload): void {
  lastSelection = {
    ...payload,
    content: payload.content,
  };
}

export function clearPartnerSelection(): void {
  lastSelection = null;
}

/** Match pasted text against the last editor copy (WebView custom MIME is unreliable). */
export function consumePartnerSelection(pastedText: string): PartnerSelectionPayload | null {
  if (!lastSelection) return null;
  if (lastSelection.content !== pastedText && lastSelection.content !== pastedText.replace(/\r\n/g, "\n")) {
    return null;
  }
  const hit = lastSelection;
  lastSelection = null;
  return hit;
}

export function peekPartnerSelection(): PartnerSelectionPayload | null {
  return lastSelection;
}

export function setPartnerPathsDrag(
  dataTransfer: DataTransfer,
  items: PartnerPathDragItem[],
): void {
  const payload = JSON.stringify(items);
  dataTransfer.setData(PARTNER_PATHS_MIME, payload);
  dataTransfer.setData("text/plain", items.map((item) => item.path).join("\n"));
  dataTransfer.effectAllowed = "copy";
  activePartnerDrag = items.map((item) => ({ ...item }));
}

export function clearActivePartnerDrag(): void {
  activePartnerDrag = null;
}

export function peekActivePartnerDrag(): PartnerPathDragItem[] | null {
  return activePartnerDrag;
}

/**
 * Finish an internal partner path drag. When Tauri's native DnD intercepts DOM
 * `drop`, HTML5 never completes — call this from `dragend` with the pointer
 * position and route into the chat drop zone if it hits.
 */
export function finishPartnerPathsDragAt(
  clientX: number,
  clientY: number,
): PartnerPathDragItem[] | null {
  const items = activePartnerDrag;
  activePartnerDrag = null;
  if (!items?.length) return null;
  if (isPointOverChatDropZone(clientX, clientY)) return items;
  return null;
}

export function readPartnerPathsDrag(dataTransfer: DataTransfer | null): PartnerPathDragItem[] {
  if (!dataTransfer) return [];
  const raw = dataTransfer.getData(PARTNER_PATHS_MIME);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const record = item as Record<string, unknown>;
          if (typeof record.path !== "string" || !record.path.trim()) return null;
          return {
            path: record.path,
            isDir: Boolean(record.isDir),
          };
        })
        .filter((item): item is PartnerPathDragItem => Boolean(item));
    } catch {
      return [];
    }
  }
  return [];
}

export function writePartnerSelectionClipboard(
  clipboardData: DataTransfer,
  payload: PartnerSelectionPayload,
): void {
  rememberPartnerSelection(payload);
  clipboardData.setData("text/plain", payload.content);
  try {
    clipboardData.setData(PARTNER_SELECTION_MIME, JSON.stringify(payload));
  } catch {
    // Custom MIME may be rejected by the host; in-memory registry still works.
  }
}

export function readPartnerSelectionClipboard(
  clipboardData: DataTransfer | null,
): PartnerSelectionPayload | null {
  if (!clipboardData) return null;
  const raw = clipboardData.getData(PARTNER_SELECTION_MIME);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object") return null;
      const record = parsed as Record<string, unknown>;
      if (
        typeof record.path !== "string" ||
        typeof record.name !== "string" ||
        typeof record.content !== "string" ||
        typeof record.startLine !== "number" ||
        typeof record.endLine !== "number"
      ) {
        return null;
      }
      return {
        path: record.path,
        name: record.name,
        content: record.content,
        startLine: record.startLine,
        endLine: record.endLine,
      };
    } catch {
      return null;
    }
  }
  const text = clipboardData.getData("text/plain");
  if (!text) return null;
  return consumePartnerSelection(text);
}

export function basenamePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

/** Convert Tauri physical drop coordinates to CSS viewport points for hit-testing. */
export function physicalToCssPoint(
  position: { x: number; y: number },
  devicePixelRatio?: number,
): { x: number; y: number } {
  const raw =
    devicePixelRatio ??
    (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
  const ratio = raw > 0 ? raw : 1;
  return { x: position.x / ratio, y: position.y / ratio };
}

function isPointInSelector(clientX: number, clientY: number, selector: string): boolean {
  if (typeof document === "undefined") return false;
  const nodes = document.querySelectorAll(selector);
  for (const node of nodes) {
    if (!node || typeof (node as Element).getBoundingClientRect !== "function") continue;
    const rect = (node as Element).getBoundingClientRect();
    if (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    ) {
      return true;
    }
  }
  return false;
}

/** Composer form (narrow) — kept for tests / precise targeting. */
export function isPointOverComposerDrop(clientX: number, clientY: number): boolean {
  if (isPointInSelector(clientX, clientY, "[data-composer-drop]")) return true;
  // Fallback when overlays steal the topmost element.
  if (typeof document === "undefined") return false;
  const el = document.elementFromPoint?.(clientX, clientY);
  return Boolean(el?.closest("[data-composer-drop]"));
}

/** Whole chat column — Finder / tab drops into conversation context. */
export function isPointOverChatDropZone(clientX: number, clientY: number): boolean {
  if (isPointInSelector(clientX, clientY, "[data-chat-drop]")) return true;
  if (isPointOverComposerDrop(clientX, clientY)) return true;
  if (typeof document === "undefined") return false;
  const el = document.elementFromPoint?.(clientX, clientY);
  return Boolean(el?.closest("[data-chat-drop], [data-composer-drop]"));
}

/**
 * Resolve Tauri drop coordinates. Some builds report physical pixels, others
 * already CSS points — try both against the chat drop zone.
 */
export function resolveDropClientPoint(position: { x: number; y: number }): {
  x: number;
  y: number;
} {
  const scaled = physicalToCssPoint(position);
  if (isPointOverChatDropZone(scaled.x, scaled.y)) return scaled;
  if (isPointOverChatDropZone(position.x, position.y)) {
    return { x: position.x, y: position.y };
  }
  return scaled;
}
