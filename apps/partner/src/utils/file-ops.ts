import {
  copyPath,
  createDir,
  deletePath,
  listDir,
  renamePath,
  revealInOs,
  writeFile,
} from "@/bridge";
import { copyTextToClipboard } from "@/utils/clipboard";
import { relativeWorkspacePath } from "@/utils/quick-open-path";
import { useFileClipboardStore, type FileClipboardEntry } from "@/stores/file-clipboard";
import { usePreviewStore } from "@/stores/preview";
import { confirmDialog } from "@/utils/native-dialog";
import { openWorkspaceFile } from "@/utils/open-workspace-file";

export function parentDir(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return normalized;
  return normalized.slice(0, index);
}

export function joinPath(parent: string, name: string): string {
  return `${parent.replace(/\/$/, "")}/${name}`;
}

export function fileName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").pop() || normalized;
}

/** Pick a non-colliding name in `parentDir` (VS Code style: `name copy.ext`). */
export function uniqueNameInDir(baseName: string, existing: Set<string>): string {
  if (!existing.has(baseName)) return baseName;
  const dot = baseName.lastIndexOf(".");
  const hasExt = dot > 0;
  const stem = hasExt ? baseName.slice(0, dot) : baseName;
  const ext = hasExt ? baseName.slice(dot) : "";
  let index = 1;
  while (true) {
    const candidate = index === 1 ? `${stem} copy${ext}` : `${stem} copy ${index}${ext}`;
    if (!existing.has(candidate)) return candidate;
    index += 1;
  }
}

export async function copyAbsolutePath(path: string): Promise<void> {
  await copyTextToClipboard(path);
}

export async function copyRelativePath(root: string, path: string): Promise<void> {
  await copyTextToClipboard(relativeWorkspacePath(root, path));
}

export function cutOrCopyEntries(
  mode: "copy" | "cut",
  entries: FileClipboardEntry[],
): void {
  useFileClipboardStore().setClipboard(mode, entries);
}

export async function revealPathInOs(path: string): Promise<void> {
  await revealInOs(path);
}

export async function deleteEntries(
  entries: FileClipboardEntry[],
): Promise<boolean> {
  if (!entries.length) return false;
  const label =
    entries.length === 1
      ? `「${entries[0]!.name}」`
      : `${entries.length} 个项目`;
  const ok = await confirmDialog(`将 ${label} 移到废纸篓？`, {
    title: "移到废纸篓",
  });
  if (!ok) return false;

  const preview = usePreviewStore();
  for (const entry of entries) {
    await deletePath(entry.path);
    const tabId = `code:${entry.path}`;
    if (preview.tabs.some((tab) => tab.id === tabId)) {
      preview.closeTab(tabId);
    }
  }
  return true;
}

export async function renameEntry(
  path: string,
  nextName: string,
): Promise<string | null> {
  const trimmed = nextName.trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\")) {
    return null;
  }
  const nextPath = joinPath(parentDir(path), trimmed);
  if (nextPath === path) return path;
  await renamePath(path, nextPath);

  const preview = usePreviewStore();
  const oldId = `code:${path}`;
  const tab = preview.tabs.find((item) => item.id === oldId);
  if (tab) {
    const content = tab.content ?? "";
    preview.closeTab(oldId);
    preview.openCodeFile(nextPath, content);
    if (tab.isDirty && tab.content != null) {
      preview.updateCodeFileContent(nextPath, tab.content);
    }
  }
  return nextPath;
}

function assertSafeName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") {
    throw new Error("名称无效");
  }
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error("名称不能包含路径分隔符");
  }
  return trimmed;
}

export async function createFileInDir(
  parentDirPath: string,
  name: string,
): Promise<string> {
  const safeName = assertSafeName(name);
  const existing = new Set((await listDir(parentDirPath)).map((entry) => entry.name));
  if (existing.has(safeName)) {
    throw new Error(`已存在同名文件或文件夹：${safeName}`);
  }
  const path = joinPath(parentDirPath, safeName);
  await writeFile(path, "");
  await openWorkspaceFile(path);
  return path;
}

export async function createFolderInDir(
  parentDirPath: string,
  name: string,
): Promise<string> {
  const safeName = assertSafeName(name);
  const existing = new Set((await listDir(parentDirPath)).map((entry) => entry.name));
  if (existing.has(safeName)) {
    throw new Error(`已存在同名文件或文件夹：${safeName}`);
  }
  const path = joinPath(parentDirPath, safeName);
  await createDir(path);
  return path;
}

export async function pasteClipboardInto(targetDir: string): Promise<boolean> {
  const clipboard = useFileClipboardStore();
  if (!clipboard.hasEntries || !clipboard.mode) return false;

  const existing = new Set((await listDir(targetDir)).map((entry) => entry.name));
  const mode = clipboard.mode;
  const entries = [...clipboard.entries];

  const normalizedTarget = targetDir.replace(/\/$/, "");
  for (const entry of entries) {
    const sourceParent = parentDir(entry.path);
    // Cut into the same folder is a no-op.
    if (mode === "cut" && sourceParent === normalizedTarget) {
      continue;
    }
    const name = uniqueNameInDir(entry.name, existing);
    existing.add(name);
    const destination = joinPath(targetDir, name);
    if (mode === "copy") {
      await copyPath(entry.path, destination);
    } else {
      await renamePath(entry.path, destination);
      const preview = usePreviewStore();
      const oldId = `code:${entry.path}`;
      const tab = preview.tabs.find((item) => item.id === oldId);
      if (tab) {
        const content = tab.content ?? "";
        preview.closeTab(oldId);
        preview.openCodeFile(destination, content);
      }
    }
  }

  if (mode === "cut") {
    clipboard.clear();
  }
  return true;
}
