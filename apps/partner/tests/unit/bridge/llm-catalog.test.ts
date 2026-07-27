import { beforeEach, describe, expect, it, vi } from "vitest";

const hostDispatch = vi.fn();

vi.mock("@/shell", () => ({
  hostDispatch: (...args: unknown[]) => hostDispatch(...args),
}));

describe("llm-catalog via host", () => {
  beforeEach(() => {
    hostDispatch.mockReset();
  });

  it("listLlmProviders uses host.llm.list_providers", async () => {
    hostDispatch.mockResolvedValueOnce({
      providers: [{ id: "p1", name: "P1" }],
    });
    const { listLlmProviders } = await import("@/bridge/llm-catalog");
    const providers = await listLlmProviders("/repo");
    expect(hostDispatch).toHaveBeenCalledWith({
      op: "host.llm.list_providers",
      projectRoot: "/repo",
    });
    expect(providers).toEqual([{ id: "p1", name: "P1" }]);
  });
});
