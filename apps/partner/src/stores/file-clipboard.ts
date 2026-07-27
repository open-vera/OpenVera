import { defineStore } from "pinia";

export type FileClipboardMode = "copy" | "cut";

export interface FileClipboardEntry {
  path: string;
  isDir: boolean;
  name: string;
}

export const useFileClipboardStore = defineStore("fileClipboard", {
  state: () => ({
    mode: null as FileClipboardMode | null,
    entries: [] as FileClipboardEntry[],
  }),
  getters: {
    hasEntries(state): boolean {
      return state.entries.length > 0 && state.mode != null;
    },
  },
  actions: {
    setClipboard(mode: FileClipboardMode, entries: FileClipboardEntry[]) {
      this.mode = mode;
      this.entries = entries;
    },
    clear() {
      this.mode = null;
      this.entries = [];
    },
  },
});
