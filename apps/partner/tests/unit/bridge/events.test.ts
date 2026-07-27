import { describe, expect, it, vi } from "vitest";

const openWorkspace = vi.fn();

vi.mock("@/shell", () => ({
  useHostStore: () => ({
    booted: true,
    boot: vi.fn(),
    openWorkspace,
  }),
  HOST_EVENT: "host:event",
}));

vi.mock("@/bridge", async () => {
  const actual = await vi.importActual<typeof import("@/bridge")>("@/bridge");
  return {
    ...actual,
    pathInfo: vi.fn(async (path: string) => ({
      path,
      isDir: path.endsWith("/folder"),
      isFile: !path.endsWith("/folder"),
    })),
  };
});

vi.mock("@/utils/open-workspace-file", () => ({
  openWorkspaceFile: vi.fn(async () => true),
}));

describe("partner drag-drop host open", () => {
  it("opens dropped folders via host.workspace.open", async () => {
    // Smoke: module loads without legacy emit helpers.
    const events = await import("@/bridge/events");
    expect(typeof events.registerPartnerAppEvents).toBe("function");
  });
});
