import { acceptHMRUpdate, defineStore } from "pinia";
import { hostBoot, hostDispatch, subscribeHostEvent, subscribeHostPatch } from "./host-client";
import type { HostCommand, HostPatchUpdate, HostState } from "./types";

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
    sectionRevisions: { sessions: 0, projects: 0, projectRuntime: 0 },
  };
}

/**
 * Fold a patch into the current document.
 *
 * The Host omits sections whose content did not change (sessions alone are ~99%
 * of the payload), so an absent key means "keep what you have". Assigning
 * `patch.state` wholesale would silently empty the session tree.
 */
export function mergeHostPatch(
  current: HostState,
  patch: HostPatchUpdate,
): HostState {
  const omitted = new Set<string>(patch.omitted ?? []);
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch.state ?? {})) {
    // A section the Host declared omitted is absent by contract; ignoring any
    // value found under it keeps one authoritative source per key.
    if (omitted.has(key) || value === undefined) continue;
    next[key] = value;
  }
  const fallback = emptyHostState() as unknown as Record<string, unknown>;
  for (const section of omitted) {
    // Nothing to carry forward (patch arrived before the first snapshot): use
    // the empty shape rather than leaving getters to read `undefined`.
    if (next[section] === undefined) next[section] = fallback[section];
  }
  return next as unknown as HostState;
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
    applyPatch(patch: HostPatchUpdate) {
      if (patch.replace || patch.revision >= this.doc.revision) {
        this.doc = mergeHostPatch(this.doc, patch);
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
