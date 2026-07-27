import { beforeEach, describe, expect, it, vi } from "vitest";

const listDirMock = vi.fn();
const writeFileMock = vi.fn();
const createDirMock = vi.fn();
const deletePathMock = vi.fn();
const openWorkspaceFileMock = vi.fn();
const confirmDialogMock = vi.fn();

vi.mock("@/bridge", () => ({
  listDir: (...args: unknown[]) => listDirMock(...args),
  writeFile: (...args: unknown[]) => writeFileMock(...args),
  createDir: (...args: unknown[]) => createDirMock(...args),
  copyPath: vi.fn(),
  deletePath: (...args: unknown[]) => deletePathMock(...args),
  renamePath: vi.fn(),
  revealInOs: vi.fn(),
}));

vi.mock("@/utils/open-workspace-file", () => ({
  openWorkspaceFile: (...args: unknown[]) => openWorkspaceFileMock(...args),
}));

vi.mock("@/utils/clipboard", () => ({
  copyTextToClipboard: vi.fn(),
}));

vi.mock("@/utils/native-dialog", () => ({
  confirmDialog: (...args: unknown[]) => confirmDialogMock(...args),
}));

vi.mock("@/stores/file-clipboard", () => ({
  useFileClipboardStore: () => ({
    hasEntries: false,
    mode: null,
    entries: [],
    setClipboard: vi.fn(),
    clear: vi.fn(),
  }),
}));

vi.mock("@/stores/preview", () => ({
  usePreviewStore: () => ({
    tabs: [],
    closeTab: vi.fn(),
    openCodeFile: vi.fn(),
    updateCodeFileContent: vi.fn(),
  }),
}));

import {
  createFileInDir,
  createFolderInDir,
  deleteEntries,
  fileName,
  joinPath,
  parentDir,
  uniqueNameInDir,
} from "@/utils/file-ops";

describe("file-ops helpers", () => {
  beforeEach(() => {
    listDirMock.mockReset();
    writeFileMock.mockReset();
    createDirMock.mockReset();
    deletePathMock.mockReset();
    openWorkspaceFileMock.mockReset();
    confirmDialogMock.mockReset();
  });

  it("computes parent and join paths", () => {
    expect(parentDir("/proj/src/app.ts")).toBe("/proj/src");
    expect(joinPath("/proj/src", "app.ts")).toBe("/proj/src/app.ts");
    expect(fileName("/proj/src/app.ts")).toBe("app.ts");
  });

  it("picks unique sibling names", () => {
    const existing = new Set(["app.ts", "app copy.ts"]);
    expect(uniqueNameInDir("readme.md", existing)).toBe("readme.md");
    expect(uniqueNameInDir("app.ts", existing)).toBe("app copy 2.ts");
  });

  it("creates a new file and opens it", async () => {
    listDirMock.mockResolvedValue([{ name: "a.ts", isDir: false }]);
    writeFileMock.mockResolvedValue(undefined);
    openWorkspaceFileMock.mockResolvedValue(undefined);

    const path = await createFileInDir("/proj/src", "b.ts");
    expect(path).toBe("/proj/src/b.ts");
    expect(writeFileMock).toHaveBeenCalledWith("/proj/src/b.ts", "");
    expect(openWorkspaceFileMock).toHaveBeenCalledWith("/proj/src/b.ts");
  });

  it("rejects duplicate create names", async () => {
    listDirMock.mockResolvedValue([{ name: "b.ts", isDir: false }]);
    await expect(createFileInDir("/proj/src", "b.ts")).rejects.toThrow(/已存在/);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("creates a new folder", async () => {
    listDirMock.mockResolvedValue([]);
    createDirMock.mockResolvedValue(undefined);
    const path = await createFolderInDir("/proj/src", "lib");
    expect(path).toBe("/proj/src/lib");
    expect(createDirMock).toHaveBeenCalledWith("/proj/src/lib");
  });

  it("confirms trash move before deleting", async () => {
    confirmDialogMock.mockResolvedValue(true);
    deletePathMock.mockResolvedValue(undefined);

    await expect(
      deleteEntries([{ path: "/proj/src/a.ts", name: "a.ts", isDir: false }]),
    ).resolves.toBe(true);

    expect(confirmDialogMock).toHaveBeenCalledWith("将 「a.ts」 移到废纸篓？", {
      title: "移到废纸篓",
    });
    expect(deletePathMock).toHaveBeenCalledWith("/proj/src/a.ts");
  });
});
