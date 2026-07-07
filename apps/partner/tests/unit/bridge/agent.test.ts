import { describe, expect, it, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
const listenMock = vi.fn(async () => () => {});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (_event: string, _handler: unknown) => listenMock(),
}));

describe("invokeAgentRun", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => {});
  });

  it("calls agent_run with trimmed history", async () => {
    const { invokeAgentRun } = await import("@/bridge/agent");
    invokeMock.mockResolvedValue(undefined);

    await invokeAgentRun({
      requestId: "req-1",
      instanceId: "inst-1",
      sessionId: "sess-1",
      message: "hello",
      history: [
        {
          id: "1",
          role: "user",
          content: "hi",
          timestamp: 1,
        },
        {
          id: "2",
          role: "assistant",
          content: "",
          timestamp: 2,
          isStreaming: true,
        },
      ],
    });

    expect(invokeMock).toHaveBeenCalledWith("agent_run", {
      requestId: "req-1",
      instanceId: "inst-1",
      sessionId: "sess-1",
      message: "hello",
      history: [{ role: "user", content: "hi" }],
      projectRoot: undefined,
    });
  });
});

describe("approveAgentTool", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("forwards tool approval decisions to Tauri", async () => {
    const { approveAgentTool } = await import("@/bridge/agent");
    invokeMock.mockResolvedValue(undefined);

    await approveAgentTool("call-1", true);

    expect(invokeMock).toHaveBeenCalledWith("agent_tool_approval", {
      callId: "call-1",
      approved: true,
    });
  });
});
