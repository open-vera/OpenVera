import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  HostCommand,
  HostCommandResult,
  HostPatch,
  HostState,
} from "./types";
import { HOST_EVENT, HOST_PATCH_EVENT } from "./types";
import { syncLog } from "@/utils/sync-log";

/**
 * Identity of this module instance.
 *
 * Every Host write is attributed to it, so a second writer — another page, or a
 * hot-reloaded module generation still holding an old store — shows up as a
 * different id in the log instead of being indistinguishable.
 */
const CLIENT_ID = Math.random().toString(36).slice(2, 8);

/** Ops that move Host-owned tab/preview state, i.e. the ones worth attributing. */
const TRACKED_OPS = new Set([
  "host.app.replace_state",
  "host.app.activate_session",
  "host.app.set_active_tab",
  "host.app.open_tab",
  "host.app.close_tab",
  "host.app.reorder_tabs",
  "host.workspace.open",
  "host.workspace.set_preview_project",
  "host.document.open",
]);

export async function hostBoot(): Promise<HostState> {
  return invoke<HostState>("host_boot");
}

export async function hostDispatch<T = unknown>(
  command: HostCommand,
): Promise<T> {
  if (TRACKED_OPS.has(command.op)) {
    const payload = command as unknown as Record<string, unknown>;
    const document = payload.document as { activeTabId?: unknown } | undefined;
    syncLog("hostDispatch", {
      client: CLIENT_ID,
      op: command.op,
      tabId: payload.tabId ?? payload.sessionId ?? undefined,
      projectId: payload.projectId ?? undefined,
      path: payload.path ?? undefined,
      documentActive: document?.activeTabId,
    });
  }
  const result = await invoke<HostCommandResult>("host_dispatch", { command });
  if (!result.ok) {
    throw new Error(result.error || "host_dispatch failed");
  }
  return result.data as T;
}

export async function subscribeHostPatch(
  onPatch: (patch: HostPatch) => void,
): Promise<UnlistenFn> {
  return listen<HostPatch>(HOST_PATCH_EVENT, (event) => {
    onPatch(event.payload);
  });
}

export async function subscribeHostEvent(
  onEvent: (event: unknown) => void,
): Promise<UnlistenFn> {
  return listen(HOST_EVENT, (event) => {
    onEvent(event.payload);
  });
}
