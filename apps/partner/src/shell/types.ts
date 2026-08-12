/** Partner Host IPC types (mirrors Rust host protocol v1). */

export const HOST_PROTOCOL_VERSION = 1;
export const HOST_PATCH_EVENT = "host:patch";
export const HOST_EVENT = "host:event";

export interface HostLayout {
  leftWidth: number;
  previewWidth: number;
  leftOpen: boolean;
  previewOpen: boolean;
  explorerOpen: boolean;
  editorOpen: boolean;
}

export interface HostDirEntry {
  name: string;
  isDir: boolean;
  path: string;
}

export interface HostGitChange {
  path: string;
  status: string;
}

export interface HostGitSummary {
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  rebasing: boolean;
  loading?: boolean;
  error?: string;
}

export interface HostProjectRuntime {
  entries: HostDirEntry[];
  gitChanges: HostGitChange[];
  gitSummary: HostGitSummary;
}

export interface HostProject {
  id: string;
  rootPath: string;
  name: string;
  expanded: boolean;
  preview: {
    version: number;
    activeTabId: string | null;
    tabs: Array<Record<string, unknown>>;
  };
  updatedAt: number;
}

export interface HostSession {
  id: string;
  projectId: string | null;
  title: string;
  messages: Array<Record<string, unknown>>;
  lastError?: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface HostOrchestrator {
  runningSessionId: string | null;
  runningRequestId: string | null;
  queue: Array<Record<string, unknown>>;
  maxConcurrency: number;
}

/** Sections a patch may leave out when the Shell's copy is already current. */
export type HostStateSection = "sessions" | "projects" | "projectRuntime";

export const HOST_PATCH_SECTIONS: readonly HostStateSection[] = [
  "sessions",
  "projects",
  "projectRuntime",
];

export interface HostSectionRevisions {
  sessions: number;
  projects: number;
  projectRuntime: number;
}

export interface HostState {
  protocolVersion: number;
  revision: number;
  version: number;
  projects: HostProject[];
  sessions: Record<string, HostSession>;
  openTabIds: string[];
  activeTabId: string | null;
  previewProjectId: string | null;
  layout: HostLayout;
  updatedAt: number;
  projectRuntime: Record<string, HostProjectRuntime>;
  orchestrator: HostOrchestrator;
  booted: boolean;
  sectionRevisions: HostSectionRevisions;
}

/**
 * State document carried by a patch.
 *
 * The omittable sections are optional: a missing key means "unchanged, keep
 * yours", which is only ever claimed via `HostPatch.omitted`.
 */
export type HostPatchState = Omit<HostState, HostStateSection> &
  Partial<Pick<HostState, HostStateSection>>;

export interface HostPatch {
  protocolVersion: number;
  revision: number;
  replace: boolean;
  /**
   * Sections absent from `state` because the Host knows they did not change.
   * An empty/missing list means `state` is complete, so an absent-and-unchanged
   * section is never confused with a present-and-empty one.
   */
  omitted?: HostStateSection[];
  state: HostPatchState;
}

/** What `applyPatch` needs: the patch minus the transport envelope. */
export type HostPatchUpdate = Pick<
  HostPatch,
  "replace" | "revision" | "state" | "omitted"
>;

export interface HostCommandResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export type HostCommand =
  | { op: "host.app.get_state" }
  | { op: "host.app.replace_state"; document: unknown }
  | { op: "host.app.set_layout"; layout: HostLayout }
  | { op: "host.app.set_active_tab"; tabId: string | null }
  | { op: "host.app.open_tab"; tabId: string }
  | { op: "host.app.close_tab"; tabId: string }
  | { op: "host.app.activate_session"; sessionId: string }
  | { op: "host.app.reorder_tabs"; tabIds: string[] }
  | { op: "host.app.version" }
  | { op: "host.workspace.open"; path: string }
  | { op: "host.workspace.close"; projectId: string }
  | { op: "host.workspace.set_preview_project"; projectId: string | null }
  | {
      op: "host.workspace.set_project_expanded";
      projectId: string;
      expanded: boolean;
    }
  | { op: "host.workspace.list_dir"; path: string }
  | { op: "host.workspace.watch_dir"; path: string }
  | { op: "host.workspace.refresh_git"; projectId?: string | null }
  | { op: "host.session.create"; projectId?: string | null; title?: string }
  | {
      op: "host.session.update";
      sessionId: string;
      title?: string;
      messages?: unknown;
    }
  | { op: "host.session.delete"; sessionId: string }
  | {
      op: "host.session.send";
      sessionId: string;
      text: string;
      attachments?: unknown;
      projectRoot?: string | null;
      llmConfig?: unknown;
      agentMode?: string | null;
    }
  | { op: "host.session.abort"; sessionId: string }
  | {
      op: "host.document.open";
      projectId: string;
      path: string;
      languageId?: string | null;
    }
  | { op: "host.document.close"; projectId: string; tabId: string }
  | {
      op: "host.document.set_active";
      projectId: string;
      tabId: string | null;
    }
  | {
      op: "host.document.set_dirty";
      projectId: string;
      tabId: string;
      dirty: boolean;
    }
  | {
      op: "host.document.replace_preview";
      projectId: string;
      preview: unknown;
    }
  | {
      op: "host.pty.spawn";
      cwd?: string | null;
      cols?: number;
      rows?: number;
    }
  | { op: "host.pty.write"; id: string; data: string }
  | { op: "host.pty.resize"; id: string; cols: number; rows: number }
  | { op: "host.pty.kill"; id: string }
  | {
      op: "host.lsp.start";
      languageId: string;
      workspaceRoot: string;
    }
  | { op: "host.lsp.stop"; languageId: string }
  | { op: "host.lsp.status" }
  | {
      op: "host.lsp.symbol_search";
      workspaceRoot: string;
      query: string;
      languageId?: string | null;
    }
  | { op: "host.menu.action"; action: string }
  | { op: "host.sidecar.status" }
  | { op: "host.agent.tool_approval"; callId: string; approved: boolean }
  | { op: "host.fs.read"; path: string }
  | { op: "host.fs.write"; path: string; content: string }
  | { op: "host.fs.append"; path: string; content: string }
  | { op: "host.fs.path_info"; path: string }
  | {
      op: "host.fs.search_files";
      root: string;
      query: string;
      limit?: number;
      include?: string;
      exclude?: string;
    }
  | {
      op: "host.fs.search_content";
      root: string;
      query: string;
      limit?: number;
      include?: string;
      exclude?: string;
    }
  | {
      op: "host.fs.replace_content";
      root: string;
      query: string;
      replacement: string;
      include?: string;
      exclude?: string;
    }
  | { op: "host.fs.create_dir"; path: string }
  | { op: "host.fs.rename"; from: string; to: string }
  | { op: "host.fs.delete"; path: string }
  | { op: "host.fs.copy"; from: string; to: string }
  | { op: "host.fs.reveal"; path: string }
  | { op: "host.fs.read_data_url"; path: string }
  | {
      op: "host.run_log.read";
      projectRoot: string;
      taskId?: string | null;
      maxBytes?: number;
    }
  | { op: "host.storage.usage"; projectRoot?: string | null }
  | {
      op: "host.shell.execute";
      cmd: string;
      args: string[];
      cwd?: string;
      timeoutMs?: number;
      confirmed?: boolean;
    }
  | { op: "host.keychain.store"; service: string; key: string; value: string }
  | { op: "host.keychain.get"; service: string; key: string }
  | { op: "host.keychain.delete"; service: string; key: string }
  | { op: "host.keychain.default_service" }
  | { op: "host.llm.inspect"; projectRoot?: string; revealSecrets?: boolean }
  | { op: "host.llm.save"; projectRoot?: string; config: unknown }
  | {
      op: "host.llm.rename_provider";
      projectRoot?: string;
      fromId: string;
      toId: string;
    }
  | {
      op: "host.llm.save_models_routing";
      projectRoot?: string;
      models: unknown;
      routing: unknown;
    }
  | { op: "host.llm.list_providers"; projectRoot?: string }
  | {
      op: "host.llm.list_provider_models";
      projectRoot?: string;
      providerId: string;
    }
  | {
      op: "host.llm.refresh_provider_models";
      projectRoot?: string;
      providerId: string;
      protocol?: string;
    }
  | {
      op: "host.llm.test_connection";
      projectRoot?: string;
      config: unknown;
    };
