import { beforeEach, describe, expect, it, vi } from "vitest";

const hostDispatch = vi.fn();

vi.mock("@/shell", () => ({
  hostDispatch: (...args: unknown[]) => hostDispatch(...args),
}));

describe("bridge fs via host", () => {
  beforeEach(() => {
    hostDispatch.mockReset();
  });

  it("listDir uses host.workspace.list_dir", async () => {
    hostDispatch.mockResolvedValueOnce([
      { name: "a.ts", isDir: false, path: "/repo/a.ts" },
    ]);
    const { listDir } = await import("@/bridge");
    const entries = await listDir("/repo");
    expect(hostDispatch).toHaveBeenCalledWith({
      op: "host.workspace.list_dir",
      path: "/repo",
    });
    expect(entries).toEqual([{ name: "a.ts", isDir: false }]);
  });

  it("readFile uses host.fs.read", async () => {
    hostDispatch.mockResolvedValueOnce("hello");
    const { readFile } = await import("@/bridge");
    await expect(readFile("/repo/a.ts")).resolves.toBe("hello");
    expect(hostDispatch).toHaveBeenCalledWith({
      op: "host.fs.read",
      path: "/repo/a.ts",
    });
  });
});
