import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

describe("listDir", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("normalizes Tauri snake_case directory entries", async () => {
    const { listDir } = await import("@/bridge");
    invokeMock.mockResolvedValue([
      { name: "apps", is_dir: true },
      { name: "README.md", is_dir: false },
    ]);

    await expect(listDir("/workspace")).resolves.toEqual([
      { name: "apps", isDir: true },
      { name: "README.md", isDir: false },
    ]);
  });
});

describe("pathInfo", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("normalizes Tauri snake_case path metadata", async () => {
    const { pathInfo } = await import("@/bridge");
    invokeMock.mockResolvedValue({
      path: "/workspace/apps",
      is_dir: true,
      is_file: false,
    });

    await expect(pathInfo("/workspace/apps")).resolves.toEqual({
      path: "/workspace/apps",
      isDir: true,
      isFile: false,
    });
    expect(invokeMock).toHaveBeenCalledWith("path_info", {
      path: "/workspace/apps",
    });
  });
});

describe("appendFile", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("appends content through the Tauri command", async () => {
    const { appendFile } = await import("@/bridge");

    await appendFile("/workspace/.vera/run.jsonl", "{\"event\":\"user_message\"}\n");

    expect(invokeMock).toHaveBeenCalledWith("append_file", {
      path: "/workspace/.vera/run.jsonl",
      content: "{\"event\":\"user_message\"}\n",
    });
  });
});

describe("searchFiles", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("normalizes Tauri snake_case search results", async () => {
    const { searchFiles } = await import("@/bridge");
    invokeMock.mockResolvedValue([
      { name: "App.vue", path: "/workspace/src/App.vue", is_dir: false },
      { name: "components", path: "/workspace/src/components", is_dir: true },
    ]);

    await expect(searchFiles("/workspace", "app")).resolves.toEqual([
      { name: "App.vue", path: "/workspace/src/App.vue", isDir: false },
      { name: "components", path: "/workspace/src/components", isDir: true },
    ]);
    expect(invokeMock).toHaveBeenCalledWith("search_files", {
      root: "/workspace",
      query: "app",
      limit: 80,
      include: undefined,
      exclude: undefined,
    });
  });
});

describe("searchContent", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("normalizes Tauri snake_case content search results", async () => {
    const { searchContent } = await import("@/bridge");
    invokeMock.mockResolvedValue([
      {
        name: "architecture.md",
        path: "/workspace/docs/architecture.md",
        line_number: 42,
        line: "`CheckpointStore`** — JSONL-based persistent checkpoint store",
      },
    ]);

    await expect(searchContent("/workspace", "CheckpointStore")).resolves.toEqual([
      {
        name: "architecture.md",
        path: "/workspace/docs/architecture.md",
        lineNumber: 42,
        line: "`CheckpointStore`** — JSONL-based persistent checkpoint store",
      },
    ]);
    expect(invokeMock).toHaveBeenCalledWith("search_content", {
      root: "/workspace",
      query: "CheckpointStore",
      limit: 80,
      include: undefined,
      exclude: undefined,
    });
  });
});
