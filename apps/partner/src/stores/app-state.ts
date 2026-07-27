import { acceptHMRUpdate, defineStore } from "pinia";
import { useHostStore } from "@/shell";
import {
  createEmptyPartnerAppState,
  listOrphanSessions,
  listProjectSessions,
  normalizePartnerAppState,
  projectIdFromRootPath,
  projectNameFromRootPath,
  SETTINGS_TAB_ID,
  type PartnerAppState,
  type PartnerProjectRecord,
  type PartnerSessionRecord,
} from "@/utils/partner-app-state";
import type { ChatErrorNotice, Message } from "@/types";
import type { PreviewSnapshot } from "@/stores/preview";

function emptyPreview(): PreviewSnapshot {
  return { version: 1, activeTabId: null, tabs: [] };
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Shell projection of Host-owned multi-project state.
 * Persistence is exclusively via `host.app.replace_state` / Host persist.
 */
export const useAppStateStore = defineStore("partner-app-state", {
  state: () => ({
    doc: createEmptyPartnerAppState() as PartnerAppState,
    isLoaded: false,
    isSaving: false,
  }),
  getters: {
    projects(state): PartnerProjectRecord[] {
      return state.doc.projects;
    },
    orphanSessions(state): PartnerSessionRecord[] {
      return listOrphanSessions(state.doc);
    },
    sessions(state): Record<string, PartnerSessionRecord> {
      return state.doc.sessions;
    },
    previewProject(state): PartnerProjectRecord | null {
      const id = state.doc.previewProjectId;
      if (!id) return null;
      return state.doc.projects.find((project) => project.id === id) ?? null;
    },
    previewProjectId(state): string | null {
      return state.doc.previewProjectId;
    },
    activeTabId(state): string | null {
      return state.doc.activeTabId;
    },
    openTabIds(state): string[] {
      return state.doc.openTabIds;
    },
    openSessions(state): PartnerSessionRecord[] {
      return state.doc.openTabIds
        .filter((id) => id !== SETTINGS_TAB_ID)
        .map((id) => state.doc.sessions[id])
        .filter((session): session is PartnerSessionRecord => Boolean(session));
    },
  },
  actions: {
    sessionsForProject(projectId: string): PartnerSessionRecord[] {
      return listProjectSessions(this.doc, projectId);
    },

    getSession(sessionId: string): PartnerSessionRecord | null {
      return this.doc.sessions[sessionId] ?? null;
    },

    syncFromHost() {
      const host = useHostStore();
      this.doc = normalizePartnerAppState({
        version: host.doc.version,
        projects: host.doc.projects.map((project) => ({
          id: project.id,
          rootPath: project.rootPath,
          name: project.name,
          expanded: project.expanded,
          preview: {
            version: project.preview.version,
            activeTabId: project.preview.activeTabId,
            tabs: project.preview.tabs as PreviewSnapshot["tabs"],
          },
          updatedAt: project.updatedAt,
        })),
        sessions: host.doc.sessions as unknown as PartnerAppState["sessions"],
        openTabIds: host.doc.openTabIds,
        activeTabId: host.doc.activeTabId,
        previewProjectId: host.doc.previewProjectId,
        layout: host.doc.layout,
        updatedAt: host.doc.updatedAt,
      });
    },

    async load() {
      const host = useHostStore();
      if (!host.booted) await host.boot();
      this.syncFromHost();
      this.isLoaded = true;
    },

    async persist() {
      this.isSaving = true;
      try {
        const next = normalizePartnerAppState({
          ...this.doc,
          updatedAt: Date.now(),
        });
        this.doc = next;
        const host = useHostStore();
        if (!host.booted) await host.boot();
        await host.command({
          op: "host.app.replace_state",
          document: next,
        });
      } finally {
        this.isSaving = false;
      }
    },

    /** Debounced persist for high-frequency chat content sync. */
    schedulePersist(delayMs = 400) {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = setTimeout(() => {
        persistTimer = undefined;
        void this.persist();
      }, delayMs);
    },

    replaceState(next: PartnerAppState) {
      this.doc = normalizePartnerAppState(next);
      this.isLoaded = true;
    },

    /** Ensure project exists for rootPath; return project id. */
    ensureProject(rootPath: string): string {
      const normalized = rootPath.trim();
      const existing = this.doc.projects.find((project) => project.rootPath === normalized);
      if (existing) {
        existing.updatedAt = Date.now();
        return existing.id;
      }
      const id = projectIdFromRootPath(normalized);
      this.doc.projects.push({
        id,
        rootPath: normalized,
        name: projectNameFromRootPath(normalized),
        expanded: true,
        preview: emptyPreview(),
        updatedAt: Date.now(),
      });
      if (!this.doc.previewProjectId) {
        this.doc.previewProjectId = id;
      }
      return id;
    },

    toggleProjectExpanded(projectId: string) {
      const project = this.doc.projects.find((item) => item.id === projectId);
      if (!project) return;
      project.expanded = !project.expanded;
      void this.persist();
    },

    setPreviewProject(projectId: string | null) {
      if (projectId && !this.doc.projects.some((project) => project.id === projectId)) return;
      this.doc.previewProjectId = projectId;
      void this.persist();
    },

    saveProjectPreview(projectId: string, preview: PreviewSnapshot) {
      const project = this.doc.projects.find((item) => item.id === projectId);
      if (!project) return;
      project.preview = preview;
      project.updatedAt = Date.now();
      void this.persist();
    },

    createSession(options?: {
      projectId?: string | null;
      title?: string;
      messages?: Message[];
      id?: string;
    }): string {
      const id = options?.id ?? crypto.randomUUID();
      const now = Date.now();
      const projectId = options?.projectId === undefined ? null : options.projectId;
      const count = Object.keys(this.doc.sessions).length + 1;
      this.doc.sessions[id] = {
        id,
        projectId,
        title: options?.title?.trim() || `对话 ${count}`,
        messages: options?.messages ?? [],
        lastError: null,
        createdAt: now,
        updatedAt: now,
      };
      this.openSession(id, { activate: true });
      return id;
    },

    /** Open session in tab strip; optionally activate and switch preview project. */
    openSession(sessionId: string, options?: { activate?: boolean }) {
      const session = this.doc.sessions[sessionId];
      if (!session) return;
      if (!this.doc.openTabIds.includes(sessionId)) {
        this.doc.openTabIds.push(sessionId);
      }
      if (options?.activate !== false) {
        this.doc.activeTabId = sessionId;
        if (session.projectId) {
          this.doc.previewProjectId = session.projectId;
        }
      }
      void this.persist();
    },

    openSettingsTab() {
      if (!this.doc.openTabIds.includes(SETTINGS_TAB_ID)) {
        this.doc.openTabIds.push(SETTINGS_TAB_ID);
      }
      this.doc.activeTabId = SETTINGS_TAB_ID;
      // Debounced: opening settings must not block on a full Host replace_state
      // of a large sessions document.
      this.schedulePersist();
    },

    selectTab(tabId: string) {
      if (tabId !== SETTINGS_TAB_ID && !this.doc.sessions[tabId]) return;
      if (!this.doc.openTabIds.includes(tabId)) {
        this.doc.openTabIds.push(tabId);
      }
      this.doc.activeTabId = tabId;
      const session = this.doc.sessions[tabId];
      if (session?.projectId) {
        this.doc.previewProjectId = session.projectId;
      }
      void this.persist();
    },

    closeOpenTab(tabId: string) {
      const index = this.doc.openTabIds.indexOf(tabId);
      if (index < 0) return;

      // Remove from open strip only — session stays in the left tree.
      this.doc.openTabIds.splice(index, 1);
      if (this.doc.activeTabId === tabId) {
        this.doc.activeTabId =
          this.doc.openTabIds[Math.max(0, index - 1)] ??
          this.doc.openTabIds[0] ??
          null;
      }
      void this.persist();
    },

    updateSessionContent(
      sessionId: string,
      patch: {
        title?: string;
        messages?: Message[];
        lastError?: ChatErrorNotice | null;
      },
    ) {
      const session = this.doc.sessions[sessionId];
      if (!session) return;
      if (patch.title !== undefined) session.title = patch.title;
      if (patch.messages !== undefined) session.messages = patch.messages;
      if (patch.lastError !== undefined) session.lastError = patch.lastError;
      session.updatedAt = Date.now();
      void this.persist();
    },

    /** Upsert a runtime chat tab into app-state (keeps tree + tabs in sync). */
    upsertFromChatTab(tab: {
      id: string;
      title: string;
      kind: "chat" | "settings";
      messages: Message[];
      lastError?: ChatErrorNotice | null;
      lastTaskId?: string | null;
      projectId?: string | null;
    }) {
      if (tab.kind === "settings") {
        if (!this.doc.openTabIds.includes(SETTINGS_TAB_ID)) {
          this.doc.openTabIds.push(SETTINGS_TAB_ID);
        }
        return;
      }
      const existing = this.doc.sessions[tab.id];
      const now = Date.now();
      if (existing) {
        const titleChanged = existing.title !== tab.title;
        const messagesChanged = existing.messages !== tab.messages;
        const errorChanged = (existing.lastError ?? null) !== (tab.lastError ?? null);
        existing.title = tab.title;
        existing.messages = tab.messages;
        existing.lastError = tab.lastError ?? null;
        // Never clear a known task id: Shell forgets it on reload, but the
        // persisted value is what makes "open run log" work after a restart.
        if (tab.lastTaskId) existing.lastTaskId = tab.lastTaskId;
        if (tab.projectId !== undefined) existing.projectId = tab.projectId;
        // Only bump recency when content actually changes (keeps new chats on top).
        if (titleChanged || messagesChanged || errorChanged) {
          existing.updatedAt = now;
        }
      } else {
        this.doc.sessions[tab.id] = {
          id: tab.id,
          projectId: tab.projectId ?? this.doc.previewProjectId,
          title: tab.title,
          messages: tab.messages,
          lastError: tab.lastError ?? null,
          lastTaskId: tab.lastTaskId ?? null,
          createdAt: now,
          updatedAt: now,
        };
      }
      if (!this.doc.openTabIds.includes(tab.id)) {
        this.doc.openTabIds.push(tab.id);
      }
      this.schedulePersist();
    },
  },
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAppStateStore, import.meta.hot));
}

export { SETTINGS_TAB_ID };
