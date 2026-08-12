import { defineStore } from "pinia";
import { syncCaller, syncLog } from "@/utils/sync-log";

const WORKSPACE_ROOT_KEY_PREFIX = "partner:workspace-root";

function storage(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

export const useWorkspaceStore = defineStore("workspace", {
  state: () => ({
    rootPath: "" as string,
    windowId: "main",
  }),
  actions: {
    storageKey(): string {
      return `${WORKSPACE_ROOT_KEY_PREFIX}:${this.windowId}`;
    },
    setWindowId(windowId: string) {
      if (!windowId || this.windowId === windowId) return;
      this.windowId = windowId;
    },
    restoreRoot(): string {
      const value =
        storage()?.getItem(this.storageKey()) ??
        storage()?.getItem(WORKSPACE_ROOT_KEY_PREFIX) ??
        "";
      this.rootPath = value;
      return value;
    },
    setRoot(path: string) {
      if (this.rootPath !== path) {
        syncLog("workspace.setRoot", {
          from: this.rootPath,
          to: path,
          by: syncCaller(),
        });
      }
      this.rootPath = path;
      if (path) {
        storage()?.setItem(this.storageKey(), path);
      }
    },
    joinPath(name: string): string {
      if (!this.rootPath) return name;
      if (name.startsWith("/")) return name;
      return `${this.rootPath.replace(/\/$/, "")}/${name}`;
    },
  },
});
