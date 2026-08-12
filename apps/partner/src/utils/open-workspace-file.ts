import { readFile, readFileDataUrl } from "@/bridge";
import { useHostStore } from "@/shell";
import { classifyFilePath, usePreviewStore } from "@/stores/preview";
import { alertDialog, confirmDialog } from "@/utils/native-dialog";

export type OpenWorkspaceFileDeps = {
  readFile?: (path: string) => Promise<string>;
  readFileDataUrl?: (
    path: string
  ) => Promise<{ dataUrl: string; bytes: number }>;
  openCodeFile?: (path: string, content: string) => void;
  openImageFile?: (path: string, dataUrl: string, byteSize: number) => void;
  /** Return true when the file is already open and was focused. */
  focusExisting?: (path: string) => boolean;
  confirm?: (message: string) => boolean | Promise<boolean>;
  alert?: (message: string) => void | Promise<void>;
};

function fileLabel(path: string): string {
  return path.split("/").pop() || path;
}

/**
 * Open a workspace file in the code preview.
 * Known text types open directly; unknown types ask to try as text;
 * known binaries are rejected with an alert.
 * Already-open tabs are focused without re-prompting.
 */
export async function openWorkspaceFile(
  path: string,
  deps: OpenWorkspaceFileDeps = {}
): Promise<boolean> {
  const read = deps.readFile ?? readFile;
  const readDataUrl = deps.readFileDataUrl ?? readFileDataUrl;
  const openCodeFile =
    deps.openCodeFile ??
    ((filePath: string, content: string) => {
      usePreviewStore().openCodeFile(filePath, content);
    });
  const openImageFile =
    deps.openImageFile ??
    ((filePath: string, dataUrl: string, byteSize: number) => {
      usePreviewStore().openImageFile(filePath, dataUrl, byteSize);
    });
  const focusExisting =
    deps.focusExisting ??
    ((filePath: string) => usePreviewStore().focusFile(filePath));
  const confirm = deps.confirm ?? ((text: string) => confirmDialog(text));
  const alert =
    deps.alert ?? ((text: string) => alertDialog(text, { kind: "warning" }));

  if (focusExisting(path)) {
    return true;
  }

  const kind = classifyFilePath(path);
  const label = fileLabel(path);

  if (kind === "binary") {
    await alert(`「${label}」是二进制文件，暂不支持预览。`);
    return false;
  }

  if (kind === "image") {
    try {
      const media = await readDataUrl(path);
      openImageFile(path, media.dataUrl, media.bytes);
      // Deliberately not declared to the Workbench Host: host.document.open
      // carries a languageId and feeds the LSP, which has nothing to say about
      // a raster image.
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await alert(`无法预览图片「${label}」：${message}`);
      console.warn("[openWorkspaceFile] failed to open image:", path, error);
      return false;
    }
  }

  if (kind === "unknown") {
    const shouldTry = await confirm(
      `「${label}」不是已知的文本类型，是否尝试以文本方式打开？`
    );
    if (!shouldTry) return false;
  }

  try {
    const content = await read(path);
    openCodeFile(path, content);
    // Declare open document on Workbench Host (model of truth for preview tabs).
    try {
      const host = useHostStore();
      const projectId = host.doc.previewProjectId;
      if (host.booted && projectId) {
        void host.command({
          op: "host.document.open",
          projectId,
          path,
        });
      }
    } catch {
      // Host optional during unit tests without Tauri.
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await alert(`无法以文本打开「${label}」：${message}`);
    console.warn("[openWorkspaceFile] failed to open file:", path, error);
    return false;
  }
}
