import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePreviewStore } from "@/stores/preview";

const invokeMock = vi.fn();
const emitMock = vi.fn();
const listenMock = vi.fn();
const listeners = new Map<string, (event: { payload: unknown }) => void>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  TauriEvent: {
    DRAG_DROP: "tauri://drag-drop",
  },
  emit: (...args: unknown[]) => emitMock(...args),
  listen: (event: string, handler: (event: { payload: unknown }) => void) => {
    listenMock(event, handler);
    listeners.set(event, handler);
    return Promise.resolve(() => {
      listeners.delete(event);
    });
  },
}));

describe("registerPartnerAppEvents", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    invokeMock.mockReset();
    emitMock.mockReset();
    listenMock.mockClear();
    listeners.clear();
  });

  it("routes dropped folders through the workspace open event", async () => {
    const { registerPartnerAppEvents } = await import("@/bridge/events");
    await registerPartnerAppEvents({ onOpenSettings: vi.fn() });
    invokeMock.mockResolvedValue({
      path: "/workspace/next",
      is_dir: true,
      is_file: false,
    });

    listeners.get("tauri://drag-drop")?.({
      payload: { paths: ["/workspace/next"] },
    });
    await vi.waitFor(() => {
      expect(emitMock).toHaveBeenCalledWith("workspace:open-folder", {
        path: "/workspace/next",
      });
    });

    expect(invokeMock).toHaveBeenCalledWith("path_info", {
      path: "/workspace/next",
    });
  });

  it("opens dropped files in preview tabs", async () => {
    const { registerPartnerAppEvents } = await import("@/bridge/events");
    await registerPartnerAppEvents({ onOpenSettings: vi.fn() });
    invokeMock.mockImplementation((command: string) => {
      if (command === "path_info") {
        return Promise.resolve({
          path: "/workspace/src/App.vue",
          is_dir: false,
          is_file: true,
        });
      }
      if (command === "read_file") {
        return Promise.resolve("<template />\n");
      }
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });

    listeners.get("tauri://drag-drop")?.({
      payload: { paths: ["/workspace/src/App.vue"] },
    });

    const preview = usePreviewStore();
    await vi.waitFor(() => {
      expect(preview.tabs[0]?.filePath).toBe("/workspace/src/App.vue");
    });
    expect(preview.tabs[0]?.content).toBe("<template />\n");
  });
});

describe("subscribeAgentStream", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    listenMock.mockClear();
    listeners.clear();
  });

  it("forwards tool approval requests for the active run", async () => {
    const { subscribeAgentStream } = await import("@/bridge/events");
    const onToolApprovalRequired = vi.fn();

    await subscribeAgentStream({
      requestId: "req-1",
      instanceId: "inst-1",
      onDelta: vi.fn(),
      onToolApprovalRequired,
    });

    listeners.get("agent:tool_approval_required")?.({
      payload: {
        requestId: "req-1",
        instanceId: "inst-1",
        callId: "call-1",
        name: "execute_shell",
        input: { cmd: "find" },
        reason: "命令 `find` 不在白名单中，需要用户确认",
        cmd: "find",
        args: ["."],
        cwd: "/repo",
      },
    });

    expect(onToolApprovalRequired).toHaveBeenCalledWith({
      callId: "call-1",
      name: "execute_shell",
      input: { cmd: "find" },
      reason: "命令 `find` 不在白名单中，需要用户确认",
      cmd: "find",
      args: ["."],
      cwd: "/repo",
    });
  });

  it("forwards sidecar-handled tool calls without leaking protocol flags to UI", async () => {
    const { subscribeAgentStream } = await import("@/bridge/events");
    const onToolCall = vi.fn();

    await subscribeAgentStream({
      requestId: "req-1",
      instanceId: "inst-1",
      onDelta: vi.fn(),
      onToolCall,
    });

    listeners.get("agent:stream:tool_call")?.({
      payload: {
        requestId: "req-1",
        instanceId: "inst-1",
        callId: "call-1",
        name: "browser",
        input: { action: "open", url: "https://example.com" },
        handledBySidecar: true,
      },
    });

    expect(onToolCall).toHaveBeenCalledWith({
      id: "call-1",
      name: "browser",
      input: { action: "open", url: "https://example.com" },
    });
  });

  it("forwards tool results for the active run", async () => {
    const { subscribeAgentStream } = await import("@/bridge/events");
    const onToolResult = vi.fn();

    await subscribeAgentStream({
      requestId: "req-1",
      instanceId: "inst-1",
      onDelta: vi.fn(),
      onToolResult,
    });

    listeners.get("agent:stream:tool_result")?.({
      payload: {
        requestId: "req-1",
        instanceId: "inst-1",
        callId: "call-1",
        output: "ok",
        isError: false,
      },
    });

    expect(onToolResult).toHaveBeenCalledWith({
      id: "call-1",
      output: "ok",
      isError: false,
    });
  });
});
