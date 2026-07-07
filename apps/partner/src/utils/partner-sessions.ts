import type { ChatSnapshot } from "@/stores/chat";
import type { PreviewSnapshot } from "@/stores/preview";
import type { LayoutSnapshot } from "@/types";

export const PARTNER_SESSIONS_VERSION = 3;

export interface PartnerWindowSnapshot {
  windowId: string;
  chat: ChatSnapshot;
  preview: PreviewSnapshot;
  layout: LayoutSnapshot;
  updatedAt: number;
}

export interface PartnerTaskSnapshot {
  taskId: string;
  windowId: string;
  chatTabId: string;
  title: string;
  previewText: string;
  chat: ChatSnapshot;
  preview: PreviewSnapshot;
  createdAt: number;
  updatedAt: number;
}

export interface PartnerSessionsSnapshot {
  version: number;
  activeWindowId: string;
  windows: Record<string, PartnerWindowSnapshot>;
  tasks: Record<string, PartnerTaskSnapshot>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasChatSnapshot(value: unknown): value is ChatSnapshot {
  return (
    isRecord(value) &&
    typeof value.activeTabId === "string" &&
    Array.isArray(value.tabs)
  );
}

function hasPartnerWindows(value: unknown): value is PartnerSessionsSnapshot {
  return (
    isRecord(value) &&
    typeof value.activeWindowId === "string" &&
    isRecord(value.windows)
  );
}

function normalizeTask(taskId: string, value: unknown): PartnerTaskSnapshot | null {
  if (!isRecord(value) || !hasChatSnapshot(value.chat)) return null;
  const fallbackTabId = value.chat.activeTabId;
  return {
    taskId:
      typeof value.taskId === "string" && value.taskId
        ? value.taskId
        : taskId,
    windowId:
      typeof value.windowId === "string" && value.windowId
        ? value.windowId
        : "main",
    chatTabId:
      typeof value.chatTabId === "string" && value.chatTabId
        ? value.chatTabId
        : fallbackTabId,
    title:
      typeof value.title === "string" && value.title.trim()
        ? value.title
        : "未命名任务",
    previewText:
      typeof value.previewText === "string"
        ? value.previewText
        : "",
    chat: value.chat,
    preview: isRecord(value.preview)
      ? (value.preview as unknown as PreviewSnapshot)
      : { version: 1, activeTabId: null, tabs: [] },
    createdAt:
      typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
        ? value.createdAt
        : Date.now(),
    updatedAt:
      typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
        ? value.updatedAt
        : Date.now(),
  };
}

function normalizeWindow(windowId: string, value: unknown): PartnerWindowSnapshot | null {
  if (!isRecord(value) || !hasChatSnapshot(value.chat)) return null;
  return {
    windowId:
      typeof value.windowId === "string" && value.windowId
        ? value.windowId
        : windowId,
    chat: value.chat,
    preview: isRecord(value.preview)
      ? (value.preview as unknown as PreviewSnapshot)
      : { version: 1, activeTabId: null, tabs: [] },
    layout: normalizeLayout(value.layout),
    updatedAt:
      typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
        ? value.updatedAt
        : Date.now(),
  };
}

function normalizeLayout(value: unknown): LayoutSnapshot {
  if (!isRecord(value)) return { leftWidth: 240, previewWidth: 420 };
  return {
    leftWidth:
      typeof value.leftWidth === "number" && Number.isFinite(value.leftWidth)
        ? value.leftWidth
        : 240,
    previewWidth:
      typeof value.previewWidth === "number" && Number.isFinite(value.previewWidth)
        ? value.previewWidth
        : 420,
  };
}

export function normalizePartnerSessions(
  raw: unknown,
  fallbackWindow?: PartnerWindowSnapshot,
): PartnerSessionsSnapshot {
  if (hasPartnerWindows(raw)) {
    const windows = Object.fromEntries(
      Object.entries(raw.windows)
        .map(([windowId, snapshot]) => [windowId, normalizeWindow(windowId, snapshot)] as const)
        .filter((entry): entry is readonly [string, PartnerWindowSnapshot] => Boolean(entry[1])),
    );
    if (fallbackWindow && !windows[fallbackWindow.windowId]) {
      windows[fallbackWindow.windowId] = fallbackWindow;
    }
    const tasks = Object.fromEntries(
      Object.entries(isRecord(raw.tasks) ? raw.tasks : {})
        .map(([taskId, task]) => [taskId, normalizeTask(taskId, task)] as const)
        .filter((entry): entry is readonly [string, PartnerTaskSnapshot] => Boolean(entry[1])),
    );
    const activeWindowId = windows[raw.activeWindowId]
      ? raw.activeWindowId
      : fallbackWindow?.windowId ?? Object.keys(windows)[0] ?? "main";
    return {
      version: PARTNER_SESSIONS_VERSION,
      activeWindowId,
      windows,
      tasks,
    };
  }

  if (hasChatSnapshot(raw) && fallbackWindow) {
    return {
      version: PARTNER_SESSIONS_VERSION,
      activeWindowId: fallbackWindow.windowId,
      windows: {
        [fallbackWindow.windowId]: {
          ...fallbackWindow,
          chat: raw,
        },
      },
      tasks: {},
    };
  }

  if (fallbackWindow) {
    return {
      version: PARTNER_SESSIONS_VERSION,
      activeWindowId: fallbackWindow.windowId,
      windows: {
        [fallbackWindow.windowId]: fallbackWindow,
      },
      tasks: {},
    };
  }

  return {
    version: PARTNER_SESSIONS_VERSION,
    activeWindowId: "main",
    windows: {},
    tasks: {},
  };
}

export function selectPartnerWindowSnapshot(
  raw: unknown,
  windowId: string,
): PartnerWindowSnapshot | null {
  if (hasPartnerWindows(raw)) {
    return normalizeWindow(windowId, raw.windows[windowId]);
  }
  if (hasChatSnapshot(raw)) {
    return {
      windowId,
      chat: raw,
      preview: { version: 1, activeTabId: null, tabs: [] },
      layout: { leftWidth: 240, previewWidth: 420 },
      updatedAt: Date.now(),
    };
  }
  return null;
}

export function upsertPartnerWindowSnapshot(
  raw: unknown,
  window: PartnerWindowSnapshot,
): PartnerSessionsSnapshot {
  const snapshot = normalizePartnerSessions(raw);
  return {
    version: PARTNER_SESSIONS_VERSION,
    activeWindowId: window.windowId,
    windows: {
      ...snapshot.windows,
      [window.windowId]: window,
    },
    tasks: snapshot.tasks,
  };
}

export function upsertPartnerTaskSnapshot(
  raw: unknown,
  task: PartnerTaskSnapshot,
): PartnerSessionsSnapshot {
  const snapshot = normalizePartnerSessions(raw);
  return {
    version: PARTNER_SESSIONS_VERSION,
    activeWindowId: snapshot.activeWindowId,
    windows: snapshot.windows,
    tasks: {
      ...snapshot.tasks,
      [task.taskId]: task,
    },
  };
}
