import { describe, expect, it, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

describe("storage bridge", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("loads partner sessions from the project root", async () => {
    const { loadPartnerSessions } = await import("@/bridge/storage");
    invokeMock.mockResolvedValue({ version: 1 });

    const result = await loadPartnerSessions("/repo");

    expect(result).toEqual({ version: 1 });
    expect(invokeMock).toHaveBeenCalledWith("load_partner_sessions", {
      projectRoot: "/repo",
    });
  });

  it("saves partner sessions to the project root", async () => {
    const { savePartnerSessions } = await import("@/bridge/storage");
    const snapshot = { version: 1, tabs: [] };

    await savePartnerSessions("/repo", snapshot);

    expect(invokeMock).toHaveBeenCalledWith("save_partner_sessions", {
      projectRoot: "/repo",
      data: snapshot,
    });
  });
});
