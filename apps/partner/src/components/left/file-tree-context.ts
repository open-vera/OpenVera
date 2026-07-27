import type { InjectionKey, Ref } from "vue";

export type FileTreeRefreshOptions = {
  /** Expand ancestors and highlight this path after refresh. */
  revealPath?: string;
  /** Re-list only this directory (create / delete / paste / rename). */
  reloadDir?: string;
};

export type FileTreeRefreshFn = (
  options?: FileTreeRefreshOptions,
) => void | Promise<void>;

export const FILE_TREE_REFRESH_KEY: InjectionKey<FileTreeRefreshFn> =
  "file-tree-refresh" as unknown as InjectionKey<FileTreeRefreshFn>;

/** Request a single directory node to re-fetch its children. */
export interface FileTreeDirReloadRequest {
  path: string;
  token: number;
}

export interface FileTreeContextTarget {
  path: string;
  name: string;
  isDir: boolean;
}

export interface FileTreeInlineRenameSession {
  path: string;
  name: string;
}

export interface FileTreeInlineRenameApi {
  session: Ref<FileTreeInlineRenameSession | null>;
  begin: (target: FileTreeContextTarget) => void;
  commit: (nextName: string) => Promise<void>;
  cancel: () => void;
}

export type FileTreeInlineCreateMode = "new-file" | "new-folder";

export interface FileTreeInlineCreateSession {
  parentPath: string;
  mode: FileTreeInlineCreateMode;
}

export interface FileTreeInlineCreateApi {
  session: Ref<FileTreeInlineCreateSession | null>;
  begin: (parent: FileTreeContextTarget, mode: FileTreeInlineCreateMode) => void;
  commit: (name: string) => Promise<void>;
  cancel: () => void;
}

/** String keys so HMR doesn't break provide/inject with fresh Symbol identities. */
export const FILE_TREE_INLINE_RENAME_KEY: InjectionKey<FileTreeInlineRenameApi> =
  "file-tree-inline-rename" as unknown as InjectionKey<FileTreeInlineRenameApi>;

export const FILE_TREE_INLINE_CREATE_KEY: InjectionKey<FileTreeInlineCreateApi> =
  "file-tree-inline-create" as unknown as InjectionKey<FileTreeInlineCreateApi>;

/** Scroll parent for file-tree lazy loading (IntersectionObserver root). */
export const FILE_TREE_SCROLL_ROOT_KEY: InjectionKey<Ref<HTMLElement | null>> =
  "file-tree-scroll-root" as unknown as InjectionKey<Ref<HTMLElement | null>>;

export function normalizeFsPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
}
