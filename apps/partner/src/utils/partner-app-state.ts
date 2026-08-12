/**
 * Global Partner app state (multi-project + sessions).
 * Persisted at ~/.vera/partner/app-state.json — see docs/zh/partner/multi-project-layout.md
 */

import type { ChatSnapshot } from "@/stores/chat";
import type { PreviewSnapshot } from "@/stores/preview";
import type { ChatErrorNotice, LayoutSnapshot, Message } from "@/types";
import {
  normalizePartnerSessions,
  type PartnerSessionsSnapshot,
  type PartnerTaskSnapshot,
  type PartnerWindowSnapshot,
} from "./partner-sessions.js";

export const PARTNER_APP_STATE_VERSION = 4;
export const SETTINGS_TAB_ID = "settings";

export interface PartnerSessionRecord {
  id: string;
  projectId: string | null;
  title: string;
  messages: Message[];
  lastError?: ChatErrorNotice | null;
  /** Task id of the most recent run; the run log file is named after it. */
  lastTaskId?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PartnerProjectRecord {
  id: string;
  rootPath: string;
  name: string;
  expanded: boolean;
  preview: PreviewSnapshot;
  updatedAt: number;
}

export interface PartnerAppState {
  version: number;
  projects: PartnerProjectRecord[];
  sessions: Record<string, PartnerSessionRecord>;
  openTabIds: string[];
  activeTabId: string | null;
  previewProjectId: string | null;
  layout: LayoutSnapshot;
  updatedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function emptyPreview(): PreviewSnapshot {
  return { version: 1, activeTabId: null, tabs: [] };
}

function defaultLayout(): LayoutSnapshot {
  return {
    leftWidth: 240,
    previewWidth: 640,
    leftOpen: true,
    previewOpen: true,
    explorerOpen: true,
    editorOpen: true,
  };
}

/** Stable project id from absolute/normalized root path. */
export function projectIdFromRootPath(rootPath: string): string {
  const normalized = rootPath.replace(/\\/g, "/").replace(/\/+$/, "") || rootPath;
  let hash = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  }
  return `proj_${hash.toString(16)}`;
}

export function projectNameFromRootPath(rootPath: string): string {
  const normalized = rootPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || normalized || "project";
}

export function createEmptyPartnerAppState(
  layout: LayoutSnapshot = defaultLayout(),
): PartnerAppState {
  return {
    version: PARTNER_APP_STATE_VERSION,
    projects: [],
    sessions: {},
    openTabIds: [],
    activeTabId: null,
    previewProjectId: null,
    layout,
    updatedAt: Date.now(),
  };
}

function normalizePreview(value: unknown): PreviewSnapshot {
  if (!isRecord(value) || !Array.isArray(value.tabs)) return emptyPreview();
  return {
    version: typeof value.version === "number" ? value.version : 1,
    activeTabId: typeof value.activeTabId === "string" ? value.activeTabId : null,
    tabs: value.tabs as PreviewSnapshot["tabs"],
  };
}

function normalizeLayout(value: unknown): LayoutSnapshot {
  if (!isRecord(value)) return defaultLayout();
  return {
    leftWidth:
      typeof value.leftWidth === "number" && Number.isFinite(value.leftWidth)
        ? value.leftWidth
        : 240,
    previewWidth:
      typeof value.previewWidth === "number" && Number.isFinite(value.previewWidth)
        ? value.previewWidth
        : 640,
    leftOpen: value.leftOpen !== false,
    previewOpen: value.previewOpen !== false,
    explorerOpen: value.explorerOpen !== false,
    editorOpen: value.editorOpen !== false,
  };
}

function normalizeSession(id: string, value: unknown): PartnerSessionRecord | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.messages)) return null;
  const title =
    typeof value.title === "string" && value.title.trim() ? value.title.trim() : "未命名会话";
  const projectId =
    value.projectId === null
      ? null
      : typeof value.projectId === "string"
        ? value.projectId
        : null;
  const now = Date.now();
  return {
    id: typeof value.id === "string" && value.id ? value.id : id,
    projectId,
    title,
    messages: value.messages as Message[],
    lastError: (value.lastError as ChatErrorNotice | null | undefined) ?? null,
    lastTaskId: typeof value.lastTaskId === "string" ? value.lastTaskId : null,
    createdAt:
      typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
        ? value.createdAt
        : now,
    updatedAt:
      typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
        ? value.updatedAt
        : now,
  };
}

function normalizeProject(value: unknown): PartnerProjectRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value.rootPath !== "string" || !value.rootPath.trim()) return null;
  const rootPath = value.rootPath.trim();
  const id =
    typeof value.id === "string" && value.id
      ? value.id
      : projectIdFromRootPath(rootPath);
  const now = Date.now();
  return {
    id,
    rootPath,
    name:
      typeof value.name === "string" && value.name.trim()
        ? value.name.trim()
        : projectNameFromRootPath(rootPath),
    expanded: value.expanded !== false,
    preview: normalizePreview(value.preview),
    updatedAt:
      typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
        ? value.updatedAt
        : now,
  };
}

export function normalizePartnerAppState(raw: unknown): PartnerAppState {
  if (!isRecord(raw) || Number(raw.version) < PARTNER_APP_STATE_VERSION) {
    return createEmptyPartnerAppState();
  }

  const projects = Array.isArray(raw.projects)
    ? raw.projects
        .map((item) => normalizeProject(item))
        .filter((item): item is PartnerProjectRecord => Boolean(item))
    : [];

  const sessions: Record<string, PartnerSessionRecord> = {};
  if (isRecord(raw.sessions)) {
    for (const [id, value] of Object.entries(raw.sessions)) {
      const session = normalizeSession(id, value);
      if (session) sessions[session.id] = session;
    }
  }

  const projectIds = new Set(projects.map((project) => project.id));
  for (const session of Object.values(sessions)) {
    if (session.projectId && !projectIds.has(session.projectId)) {
      session.projectId = null;
    }
  }

  const openTabIds = Array.isArray(raw.openTabIds)
    ? raw.openTabIds.filter(
        (id): id is string =>
          typeof id === "string" && (id === SETTINGS_TAB_ID || Boolean(sessions[id])),
      )
    : [];

  let activeTabId =
    typeof raw.activeTabId === "string" &&
    (raw.activeTabId === SETTINGS_TAB_ID || sessions[raw.activeTabId])
      ? raw.activeTabId
      : openTabIds[0] ?? null;

  if (activeTabId && !openTabIds.includes(activeTabId)) {
    openTabIds.unshift(activeTabId);
  }

  // An explicit null means "no project scoped" (a session outside any project)
  // and must survive normalization — falling back to projects[0] would make the
  // explorer snap to an unrelated project on every projection.
  const previewProjectId =
    typeof raw.previewProjectId === "string" && projectIds.has(raw.previewProjectId)
      ? raw.previewProjectId
      : raw.previewProjectId === null
        ? null
        : projects[0]?.id ?? null;

  return {
    version: PARTNER_APP_STATE_VERSION,
    projects,
    sessions,
    openTabIds,
    activeTabId,
    previewProjectId,
    layout: normalizeLayout(raw.layout),
    updatedAt:
      typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt)
        ? raw.updatedAt
        : Date.now(),
  };
}

function sessionFromChatTab(
  tab: ChatSnapshot["tabs"][number],
  projectId: string | null,
  updatedAt: number,
): PartnerSessionRecord | null {
  if (tab.kind !== "chat") return null;
  return {
    id: tab.id,
    projectId,
    title: tab.title?.trim() || "未命名会话",
    messages: tab.messages ?? [],
    lastError: tab.lastError ?? null,
    createdAt: updatedAt,
    updatedAt,
  };
}

function sessionFromTask(
  task: PartnerTaskSnapshot,
  projectId: string,
): PartnerSessionRecord {
  const tab =
    task.chat.tabs.find((item) => item.id === task.chatTabId) ??
    task.chat.tabs.find((item) => item.kind === "chat");
  return {
    id: `task:${task.taskId}`,
    projectId,
    title: task.title?.trim() || tab?.title || "未命名任务",
    messages: tab?.messages ?? [],
    lastError: tab?.lastError ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export interface MigrateLegacyAppStateInput {
  /** Current workspace root, if any. */
  rootPath?: string | null;
  /** Raw `{root}/.vera/partner-sessions.json` payload. */
  legacySessions?: unknown;
  /** Optional window id used when selecting window snapshot. */
  windowId?: string;
}

/**
 * Build v4 app-state from legacy per-project partner-sessions.json.
 * Idempotent when fed the same inputs; does not delete legacy files.
 */
export function migrateLegacyToPartnerAppState(
  input: MigrateLegacyAppStateInput,
): PartnerAppState {
  const state = createEmptyPartnerAppState();
  const rootPath = input.rootPath?.trim() || "";
  if (!rootPath) return state;

  const projectId = projectIdFromRootPath(rootPath);
  const now = Date.now();
  const legacy = normalizePartnerSessions(input.legacySessions);
  const windowId = input.windowId || legacy.activeWindowId || "main";
  const windowSnapshot: PartnerWindowSnapshot | undefined =
    legacy.windows[windowId] ?? Object.values(legacy.windows)[0];

  state.projects.push({
    id: projectId,
    rootPath,
    name: projectNameFromRootPath(rootPath),
    expanded: true,
    preview: windowSnapshot?.preview ?? emptyPreview(),
    updatedAt: windowSnapshot?.updatedAt ?? now,
  });
  state.previewProjectId = projectId;
  state.layout = windowSnapshot?.layout ?? defaultLayout();

  const openTabIds: string[] = [];
  if (windowSnapshot) {
    for (const tab of windowSnapshot.chat.tabs) {
      if (tab.kind === "settings") {
        if (!openTabIds.includes(SETTINGS_TAB_ID)) openTabIds.push(SETTINGS_TAB_ID);
        continue;
      }
      const session = sessionFromChatTab(tab, projectId, windowSnapshot.updatedAt);
      if (!session) continue;
      state.sessions[session.id] = session;
      openTabIds.push(session.id);
    }
    const active = windowSnapshot.chat.activeTabId;
    if (active === "settings" || active === SETTINGS_TAB_ID) {
      state.activeTabId = SETTINGS_TAB_ID;
      if (!openTabIds.includes(SETTINGS_TAB_ID)) openTabIds.unshift(SETTINGS_TAB_ID);
    } else if (active && state.sessions[active]) {
      state.activeTabId = active;
    } else {
      state.activeTabId = openTabIds.find((id) => id !== SETTINGS_TAB_ID) ?? null;
    }
  }

  for (const task of Object.values(legacy.tasks)) {
    const session = sessionFromTask(task, projectId);
    if (!state.sessions[session.id]) {
      state.sessions[session.id] = session;
    }
  }

  state.openTabIds = openTabIds;
  if (!state.activeTabId) {
    state.activeTabId = openTabIds[0] ?? null;
  }
  state.updatedAt = now;
  return state;
}

/**
 * Merge legacy per-project sessions into an existing v4 document.
 * Used when app-state.json was created empty (or without this project) before
 * migration ran — without this, resolve would keep the empty v4 forever.
 */
export function mergeLegacyIntoPartnerAppState(
  existing: PartnerAppState,
  legacy: MigrateLegacyAppStateInput,
): PartnerAppState {
  const rootPath = legacy.rootPath?.trim() || "";
  if (!rootPath) return normalizePartnerAppState(existing);

  const migrated = migrateLegacyToPartnerAppState(legacy);
  if (Object.keys(migrated.sessions).length === 0 && migrated.projects.length === 0) {
    return normalizePartnerAppState(existing);
  }

  const result = normalizePartnerAppState(existing);
  let changed = false;

  for (const project of migrated.projects) {
    const found = result.projects.find(
      (item) => item.id === project.id || item.rootPath === project.rootPath,
    );
    if (!found) {
      result.projects.push(project);
      changed = true;
      continue;
    }
    if (found.preview.tabs.length === 0 && project.preview.tabs.length > 0) {
      found.preview = project.preview;
      found.updatedAt = Math.max(found.updatedAt, project.updatedAt);
      changed = true;
    }
  }

  for (const session of Object.values(migrated.sessions)) {
    const current = result.sessions[session.id];
    if (!current) {
      result.sessions[session.id] = session;
      changed = true;
      continue;
    }
    if (current.messages.length === 0 && session.messages.length > 0) {
      result.sessions[session.id] = {
        ...session,
        projectId: current.projectId ?? session.projectId,
      };
      changed = true;
    }
  }

  if (!changed) return normalizePartnerAppState(result);

  const openHasContent = result.openTabIds.some(
    (id) => (result.sessions[id]?.messages.length ?? 0) > 0,
  );
  if (!openHasContent && migrated.openTabIds.length > 0) {
    const nextOpen = migrated.openTabIds.filter(
      (id) => id === SETTINGS_TAB_ID || Boolean(result.sessions[id]),
    );
    if (nextOpen.length > 0) {
      result.openTabIds = nextOpen;
      result.activeTabId =
        migrated.activeTabId &&
        (migrated.activeTabId === SETTINGS_TAB_ID || result.sessions[migrated.activeTabId])
          ? migrated.activeTabId
          : (nextOpen.find((id) => id !== SETTINGS_TAB_ID) ?? nextOpen[0] ?? null);
    }
  }

  if (!result.previewProjectId && migrated.previewProjectId) {
    result.previewProjectId = migrated.previewProjectId;
  }

  // Drop auto-created empty orphan placeholders when we recovered real history.
  const recoveredContent = Object.values(result.sessions).some(
    (session) => session.messages.length > 0,
  );
  if (recoveredContent) {
    for (const [id, session] of Object.entries(result.sessions)) {
      if (
        session.projectId === null &&
        session.messages.length === 0 &&
        !migrated.sessions[id]
      ) {
        delete result.sessions[id];
        result.openTabIds = result.openTabIds.filter((tabId) => tabId !== id);
      }
    }
    if (result.activeTabId && !result.sessions[result.activeTabId] && result.activeTabId !== SETTINGS_TAB_ID) {
      result.activeTabId =
        result.openTabIds.find((id) => id !== SETTINGS_TAB_ID) ?? null;
    }
  }

  result.updatedAt = Date.now();
  return normalizePartnerAppState(result);
}

/** Prefer existing v4 state; merge legacy when a project root is provided. */
export function resolvePartnerAppState(options: {
  stored?: unknown;
  legacy?: MigrateLegacyAppStateInput;
}): PartnerAppState {
  if (isRecord(options.stored) && Number(options.stored.version) >= PARTNER_APP_STATE_VERSION) {
    const stored = normalizePartnerAppState(options.stored);
    if (options.legacy?.rootPath) {
      return mergeLegacyIntoPartnerAppState(stored, options.legacy);
    }
    return stored;
  }
  if (options.legacy?.rootPath) {
    return migrateLegacyToPartnerAppState(options.legacy);
  }
  return createEmptyPartnerAppState();
}

/** Newest activity first; break ties by createdAt so brand-new empty chats stay on top. */
function compareSessionsByRecency(a: PartnerSessionRecord, b: PartnerSessionRecord): number {
  if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
  return b.createdAt - a.createdAt;
}

export function listOrphanSessions(state: PartnerAppState): PartnerSessionRecord[] {
  return Object.values(state.sessions)
    .filter((session) => session.projectId === null)
    .sort(compareSessionsByRecency);
}

export function listProjectSessions(
  state: PartnerAppState,
  projectId: string,
): PartnerSessionRecord[] {
  return Object.values(state.sessions)
    .filter((session) => session.projectId === projectId)
    .sort(compareSessionsByRecency);
}

/** Tab and preview fields the Workbench Host owns exclusively. */
export interface HostOwnedTabState {
  openTabIds: string[];
  activeTabId: string | null;
  previewProjectId: string | null;
}

/**
 * Rebase Host-owned tab/preview fields onto a Shell snapshot.
 *
 * `host.app.replace_state` carries the whole document, so a Shell write that
 * only meant to sync chat content would otherwise regress an activation that
 * landed on the Host after this snapshot was taken. Host wins for the active
 * tab and preview project; tabs the Shell opened but the Host has not seen yet
 * are appended rather than dropped.
 */
export function rebaseHostOwnedTabState(
  local: PartnerAppState,
  host: HostOwnedTabState,
): PartnerAppState {
  const openTabIds = [...host.openTabIds];
  for (const id of local.openTabIds) {
    if (!openTabIds.includes(id)) openTabIds.push(id);
  }
  const activeTabId =
    host.activeTabId && openTabIds.includes(host.activeTabId)
      ? host.activeTabId
      : local.activeTabId && openTabIds.includes(local.activeTabId)
        ? local.activeTabId
        : openTabIds[0] ?? null;
  return {
    ...local,
    openTabIds,
    activeTabId,
    previewProjectId: host.previewProjectId,
  };
}

export type { PartnerSessionsSnapshot };
