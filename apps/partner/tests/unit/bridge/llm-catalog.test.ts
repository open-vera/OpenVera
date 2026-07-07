import { describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

describe("llm-catalog bridge", () => {
  it("calls test_llm_connection with provider id", async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ ok: true, modelCount: 3, message: "ok" });
    const { testLlmConnection } = await import("@/bridge/llm-catalog");

    const result = await testLlmConnection("/repo", "compony", { protocol: "openai-compatible" });

    expect(invokeMock).toHaveBeenCalledWith("test_llm_connection", {
      projectRoot: "/repo",
      providerId: "compony",
      protocol: "openai-compatible",
    });
    expect(result).toEqual({ ok: true, modelCount: 3, message: "ok" });
  });
});
