import { beforeEach, describe, expect, it, vi } from "vitest";

const abortAgentMock = vi.fn();
const invokeAgentRunMock = vi.fn();
const subscribeAgentStreamMock = vi.fn();
const waitForAgentCompletionMock = vi.fn();

vi.mock("@/bridge/agent", () => ({
  abortAgent: (...args: unknown[]) => abortAgentMock(...args),
  invokeAgentRun: (...args: unknown[]) => invokeAgentRunMock(...args),
  waitForAgentCompletion: (...args: unknown[]) => waitForAgentCompletionMock(...args),
}));

vi.mock("@/bridge/events", () => ({
  subscribeAgentStream: (...args: unknown[]) => subscribeAgentStreamMock(...args),
}));

describe("AgentInstanceRunner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    abortAgentMock.mockReset();
    invokeAgentRunMock.mockReset();
    subscribeAgentStreamMock.mockReset();
    waitForAgentCompletionMock.mockReset();
    subscribeAgentStreamMock.mockResolvedValue(() => {});
    invokeAgentRunMock.mockResolvedValue(undefined);
    waitForAgentCompletionMock.mockReturnValue(new Promise(() => {}));
  });

  it("aborts the run when no model events arrive", async () => {
    const { AgentInstanceRunner } = await import("@/orchestrator/agent-instance");
    const runner = new AgentInstanceRunner("session-1");

    const run = runner.run("hello", [], { onDelta: vi.fn() }, "/workspace");
    const rejection = expect(run).rejects.toThrow("模型响应超时");
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(45_000);
    await rejection;
    expect(abortAgentMock).toHaveBeenCalledWith("session-1");
  });

  it("rejects immediately when the stream reports an error", async () => {
    const { AgentInstanceRunner } = await import("@/orchestrator/agent-instance");
    const runner = new AgentInstanceRunner("session-1");
    let onError: ((payload: { message: string }) => void) | undefined;
    subscribeAgentStreamMock.mockImplementation(async (options: { onError?: typeof onError }) => {
      onError = options.onError;
      return () => {};
    });

    const run = runner.run("hello", [], { onDelta: vi.fn() }, "/workspace");
    await Promise.resolve();
    onError?.({ message: "403 {\"error\":\"API key scenario mismatch\"}" });

    await expect(run).rejects.toThrow("API key scenario mismatch");
    await expect(run).rejects.toMatchObject({
      diagnostics: expect.objectContaining({
        sessionId: "session-1",
        requestId: expect.any(String),
        instanceId: runner.id,
      }),
    });
    expect(runner.status).toBe("error");
    expect(abortAgentMock).not.toHaveBeenCalled();
  });

  it("rejects stream errors even before agent_run returns", async () => {
    const { AgentInstanceRunner } = await import("@/orchestrator/agent-instance");
    const runner = new AgentInstanceRunner("session-1");
    let onError: ((payload: { message: string }) => void) | undefined;
    invokeAgentRunMock.mockReturnValue(new Promise(() => {}));
    subscribeAgentStreamMock.mockImplementation(async (options: { onError?: typeof onError }) => {
      onError = options.onError;
      return () => {};
    });

    const run = runner.run("hello", [], { onDelta: vi.fn() }, "/workspace");
    await Promise.resolve();
    onError?.({ message: "403 {\"error\":\"API key scenario mismatch\"}" });

    await expect(run).rejects.toThrow("API key scenario mismatch");
    expect(runner.status).toBe("error");
  });

  it("pauses the idle timeout while waiting for tool approval", async () => {
    const { AgentInstanceRunner } = await import("@/orchestrator/agent-instance");
    const runner = new AgentInstanceRunner("session-1");
    const onToolApprovalRequired = vi.fn();
    let emitApproval:
      | ((payload: {
          callId: string;
          name: string;
          input: Record<string, unknown>;
          reason: string;
        }) => void)
      | undefined;
    subscribeAgentStreamMock.mockImplementation(
      async (options: { onToolApprovalRequired?: typeof emitApproval }) => {
        emitApproval = options.onToolApprovalRequired;
        return () => {};
      },
    );

    void runner.run(
      "hello",
      [],
      { onDelta: vi.fn(), onToolApprovalRequired },
      "/workspace",
    );
    await Promise.resolve();
    emitApproval?.({
      callId: "call-1",
      name: "execute_shell",
      input: { cmd: "find" },
      reason: "命令 `find` 不在白名单中，需要用户确认",
    });
    await vi.advanceTimersByTimeAsync(45_000);

    expect(onToolApprovalRequired).toHaveBeenCalled();
    expect(abortAgentMock).not.toHaveBeenCalled();
    runner.abort();
  });

  it("keeps stream listeners alive after manual abort so completion can settle", async () => {
    const { AgentInstanceRunner } = await import("@/orchestrator/agent-instance");
    const cleanup = vi.fn();
    const runner = new AgentInstanceRunner("session-1");
    let emitDone: ((payload: { text?: string }) => void) | undefined;
    subscribeAgentStreamMock.mockImplementation(async (options: { onDone?: typeof emitDone }) => {
      void options;
      return cleanup;
    });
    waitForAgentCompletionMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          emitDone = resolve;
        }),
    );

    const run = runner.run("hello", [], { onDelta: vi.fn() }, "/workspace");
    await Promise.resolve();
    runner.abort();
    emitDone?.({ text: "" });

    await expect(run).resolves.toEqual({ text: "" });
    expect(abortAgentMock).toHaveBeenCalledWith("session-1");
    expect(cleanup).toHaveBeenCalled();
  });
});
