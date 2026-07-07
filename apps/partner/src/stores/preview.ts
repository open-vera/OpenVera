import { defineStore } from "pinia";
import { detectLanguageFromPath } from "@/preview/language";
import type { PreviewTab } from "./preview-types.js";
export type { PreviewTab } from "./preview-types.js";
export { isCodeFilePath } from "./preview-types.js";

const SNAPSHOT_VERSION = 1;

export interface PreviewSnapshot {
  version: number;
  activeTabId: string | null;
  tabs: PreviewTab[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeTab(value: unknown): PreviewTab | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.kind !== "string" ||
    typeof value.source !== "string"
  ) {
    return null;
  }
  if (!["html", "pdf", "image", "media", "code", "markdown"].includes(value.kind)) {
    return null;
  }
  return {
    id: value.id,
    title: value.title,
    kind: value.kind,
    source: value.source,
    ...(typeof value.filePath === "string" ? { filePath: value.filePath } : {}),
    ...(typeof value.content === "string" ? { content: value.content } : {}),
    ...(typeof value.savedContent === "string" ? { savedContent: value.savedContent } : {}),
    ...(typeof value.isDirty === "boolean" ? { isDirty: value.isDirty } : {}),
    ...(typeof value.readOnly === "boolean" ? { readOnly: value.readOnly } : {}),
    ...(typeof value.languageId === "string" ? { languageId: value.languageId } : {}),
  } as PreviewTab;
}

function parseSnapshot(value: unknown): PreviewSnapshot | null {
  if (!isRecord(value) || !Array.isArray(value.tabs)) return null;
  const tabs = value.tabs
    .map(normalizeTab)
    .filter((tab): tab is PreviewTab => Boolean(tab));
  const activeTabId =
    typeof value.activeTabId === "string" &&
    tabs.some((tab) => tab.id === value.activeTabId)
      ? value.activeTabId
      : tabs[0]?.id ?? null;
  return {
    version: SNAPSHOT_VERSION,
    activeTabId,
    tabs,
  };
}

export const usePreviewStore = defineStore("preview", {
  state: () => ({
    tabs: [] as PreviewTab[],
    activeTabId: null as string | null,
    lspEnabled: true,
  }),
  actions: {
    openTab(tab: PreviewTab) {
      const existing = this.tabs.find((item) => item.id === tab.id);
      if (!existing) {
        this.tabs.push(tab);
      } else {
        Object.assign(existing, tab);
      }
      this.activeTabId = tab.id;
    },
    openCodeFile(filePath: string, content: string) {
      const id = `code:${filePath}`;
      const existing = this.tabs.find((item) => item.id === id);
      if (existing?.isDirty) {
        this.activeTabId = id;
        return;
      }
      const title = filePath.split("/").pop() ?? filePath;
      this.openTab({
        id,
        title,
        kind: "code",
        source: filePath,
        filePath,
        content,
        savedContent: content,
        isDirty: false,
        languageId: detectLanguageFromPath(filePath),
      });
    },
    openDiffFile(filePath: string, content: string) {
      const title = `${filePath.split("/").pop() ?? filePath}.diff`;
      this.openTab({
        id: `diff:${filePath}`,
        title,
        kind: "code",
        source: `git-diff:${filePath}`,
        filePath: `${filePath}.diff`,
        content,
        savedContent: content,
        isDirty: false,
        readOnly: true,
        languageId: "plaintext",
      });
    },
    updateCodeFileContent(filePath: string, content: string) {
      const tab = this.tabs.find((item) => item.id === `code:${filePath}`);
      if (!tab) return;
      tab.content = content;
      tab.isDirty = content !== (tab.savedContent ?? "");
    },
    markCodeFileSaved(filePath: string, content: string) {
      const tab = this.tabs.find((item) => item.id === `code:${filePath}`);
      if (!tab) return;
      tab.content = content;
      tab.savedContent = content;
      tab.isDirty = false;
    },
    refreshCleanCodeFile(filePath: string, content: string) {
      const tab = this.tabs.find((item) => item.id === `code:${filePath}`);
      if (!tab || tab.kind !== "code" || tab.isDirty) return;
      if (tab.savedContent === content && tab.content === content) return;
      tab.content = content;
      tab.savedContent = content;
      tab.isDirty = false;
    },
    closeTab(id: string) {
      this.tabs = this.tabs.filter((item) => item.id !== id);
      if (this.activeTabId === id) {
        this.activeTabId = this.tabs[0]?.id ?? null;
      }
    },
    setLspEnabled(enabled: boolean) {
      this.lspEnabled = enabled;
    },
    reset() {
      this.tabs = [];
      this.activeTabId = null;
    },
    exportSnapshot(): PreviewSnapshot {
      return {
        version: SNAPSHOT_VERSION,
        activeTabId: this.activeTabId,
        tabs: this.tabs.map((tab) => ({ ...tab })),
      };
    },
    restoreSnapshot(snapshot: unknown): boolean {
      const parsed = parseSnapshot(snapshot);
      if (!parsed) {
        this.reset();
        return false;
      }
      this.tabs = parsed.tabs;
      this.activeTabId = parsed.activeTabId;
      return true;
    },
  },
});
