import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { pathInfo } from "@/bridge";
import { openWorkspaceFile } from "@/utils/open-workspace-file";
import {
  deliverComposerPathDrop,
  setNativeFileDropHover,
} from "@/utils/composer-drop";
import {
  isPointOverChatDropZone,
  resolveDropClientPoint,
} from "@/utils/partner-dnd";
import { useHostStore } from "@/shell";
import { HOST_EVENT } from "@/shell/types";

interface DroppedPathInfo {
  path: string;
  isDir: boolean;
  isFile: boolean;
}

export interface PartnerAppEventHandlers {
  onOpenSettings: () => void;
  onCloseTab?: () => void;
  onSidecarUnavailable?: (info: { running: boolean; error?: string; needsNodeInstall?: boolean }) => void;
}

async function getPathInfo(path: string): Promise<DroppedPathInfo> {
  const info = await pathInfo(path);
  return {
    path: info.path,
    isDir: info.isDir,
    isFile: info.isFile,
  };
}

async function openDroppedFile(path: string): Promise<void> {
  await openWorkspaceFile(path);
}

async function openDroppedPaths(paths: string[]): Promise<void> {
  const infos = await Promise.allSettled(paths.map((path) => getPathInfo(path)));
  const validInfos = infos
    .filter((result): result is PromiseFulfilledResult<DroppedPathInfo> => result.status === "fulfilled")
    .map((result) => result.value);
  const folder = validInfos.find((info) => info.isDir);
  if (folder) {
    const host = useHostStore();
    if (!host.booted) await host.boot();
    await host.openWorkspace(folder.path);
    return;
  }

  await Promise.all(
    validInfos
      .filter((info) => info.isFile)
      .map((info) =>
        openDroppedFile(info.path).catch((error: unknown) => {
          console.warn("[DragDrop] failed to open dropped file:", error);
        }),
      ),
  );
}

function handleNativeDrop(paths: string[], position: { x: number; y: number }): void {
  const cleaned = paths.filter(Boolean);
  if (!cleaned.length) return;

  const point = resolveDropClientPoint(position);
  // Dropping anywhere on the chat column attaches as context (not only the input box).
  if (isPointOverChatDropZone(point.x, point.y)) {
    if (deliverComposerPathDrop(cleaned)) return;
  }

  void openDroppedPaths(cleaned).catch((error: unknown) => {
    console.warn("[DragDrop] failed to handle dropped paths:", error);
  });
}

function handleNativeDragHover(
  type: string,
  position?: { x: number; y: number },
): void {
  if (type === "leave" || type === "cancel") {
    setNativeFileDropHover(false);
    return;
  }
  if ((type === "enter" || type === "over") && position) {
    const point = resolveDropClientPoint(position);
    setNativeFileDropHover(isPointOverChatDropZone(point.x, point.y));
  }
}

export function registerPartnerAppEvents(
  handlers: PartnerAppEventHandlers,
): Promise<() => void> {
  return Promise.all([
    // Host menu bus (post Workbench Host rewrite).
    listen<{ kind?: string; action?: string }>(HOST_EVENT, (event) => {
      if (event.payload.kind !== "menu") return;
      if (event.payload.action === "open_settings") handlers.onOpenSettings();
      if (event.payload.action === "close_tab") handlers.onCloseTab?.();
    }),
    // Legacy native menu events — keep during Host cutover so Settings still opens
    // if the running binary emits the old channel.
    listen("app:open-settings", () => {
      handlers.onOpenSettings();
    }),
    listen("app:close-tab", () => {
      handlers.onCloseTab?.();
    }),
    listen<{ error?: string; needsNodeInstall?: boolean }>("sidecar:unavailable", (event) => {
      handlers.onSidecarUnavailable?.({
        running: false,
        error: event.payload.error,
        needsNodeInstall: event.payload.needsNodeInstall,
      });
    }),
    getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "drop") {
        setNativeFileDropHover(false);
        handleNativeDrop(payload.paths, payload.position);
        return;
      }
      handleNativeDragHover(
        payload.type,
        "position" in payload ? payload.position : undefined,
      );
    }),
  ]).then((unlisteners) => {
    return () => {
      setNativeFileDropHover(false);
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };
  });
}

