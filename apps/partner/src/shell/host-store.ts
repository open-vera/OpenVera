import { acceptHMRUpdate, defineStore } from "pinia";
import { hostBoot, hostDispatch, subscribeHostEvent, subscribeHostPatch } from "./host-client";
import type { HostCommand, HostState } from "./types";

function emptyHostState(): HostState {
  return {
    protocolVersion: 1,
    revision: 0,
    version: 4,
    projects: [],
    sessions: {},
    openTabIds: [],
    activeTabId: null,
    previewProjectId: null,
    layout: {
      leftWidth: 240,
      previewWidth: 640,
      leftOpen: true,
      previewOpen: true,
      explorerOpen: true,
      editorOpen: true,
    },
    updatedAt: 0,
    projectRuntime: {},
    orchestrator: {
      runningSessionId: null,
      runningRequestId: null,
      queue: [],
      maxConcurrency: 1,
    },
    booted: false,
  };
}

let unlistenPatch: (() => void) | undefined;
let unlistenEvent: (() => void) | undefined;

/**
 * Projection of Rust Workbench Host state.
 * Shell may hold ephemeral UI flags only; business truth lives in Host.
 */
export const useHostStore = defineStore("partner-host", {
  state: () => ({
    doc: emptyHostState() as HostState,
    booted: false,
    lastEvent: null as unknown,
  }),
  getters: {
    previewProject(state) {
      const id = state.doc.previewProjectId;
      if (!id) return null;
      return state.doc.projects.find((project) => project.id === id) ?? null;
    },
    activeSession(state) {
      const id = state.doc.activeTabId;
      if (!id || id === "settings") return null;
      return state.doc.sessions[id] ?? null;
    },
    isAgentRunning(state) {
      return Boolean(state.doc.orchestrator.runningSessionId);
    },
  },
  actions: {
    applyPatch(patch: { replace: boolean; state: HostState; revision: number }) {
      if (patch.replace || patch.revision >= this.doc.revision) {
        this.doc = patch.state;
      }
    },

    async boot() {
      if (!unlistenPatch) {
        unlistenPatch = await subscribeHostPatch((patch) => {
          this.applyPatch(patch);
        });
      }
      if (!unlistenEvent) {
        unlistenEvent = await subscribeHostEvent((event) => {
          this.lastEvent = event;
        });
      }
      const snapshot = await hostBoot();
      this.doc = snapshot;
      this.booted = true;
      return snapshot;
    },

    async command<T = unknown>(cmd: HostCommand): Promise<T> {
      return hostDispatch<T>(cmd);
    },

    async openWorkspace(path: string) {
      return this.command<{ projectId: string }>({
        op: "host.workspace.open",
        path,
      });
    },

    async listDir(path: string) {
      return this.command<
        Array<{ name: string; isDir: boolean; path: string }>
      >({
        op: "host.workspace.list_dir",
        path,
      });
    },

    async refreshGit(projectId?: string | null) {
      return this.command({
        op: "host.workspace.refresh_git",
        projectId: projectId ?? null,
      });
    },

    async createSession(projectId?: string | null, title?: string) {
      return this.command<{ sessionId: string }>({
        op: "host.session.create",
        projectId: projectId ?? null,
        title,
      });
    },

    async sendMessage(
      sessionId: string,
      text: string,
      options?: {
        projectRoot?: string | null;
        llmConfig?: unknown;
        agentMode?: string | null;
        attachments?: unknown;
      },
    ) {
      return this.command({
        op: "host.session.send",
        sessionId,
        text,
        projectRoot: options?.projectRoot ?? null,
        llmConfig: options?.llmConfig,
        agentMode: options?.agentMode ?? null,
        attachments: options?.attachments ?? [],
      });
    },

    async abortSession(sessionId: string) {
      return this.command({
        op: "host.session.abort",
        sessionId,
      });
    },

    dispose() {
      unlistenPatch?.();
      unlistenEvent?.();
      unlistenPatch = undefined;
      unlistenEvent = undefined;
    },
  },
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useHostStore, import.meta.hot));
}
