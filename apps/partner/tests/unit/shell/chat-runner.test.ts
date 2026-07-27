import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenUsage } from "@/types";

type Handler = (event: { payload: Record<string, unknown> }) => void;

const handlers: Record<string, Handler> = {};

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: Handler) => {
    handlers[name] = handler;
    return () => {};
  }),
}));

const sendMessage = vi.fn(async () => ({}));

vi.mock("@/shell/host-store", () => ({
  useHostStore: () => ({
    booted: true,
    doc: {
      activeTabId: "session-1",
      sessions: { "session-1": { id: "session-1" } },
      previewProjectId: null,
      orchestrator: { runningSessionId: null },
    },
    previewProject: null,
    boot: vi.fn(),
    sendMessage,
    createSession: vi.fn(async () => ({ sessionId: "session-1" })),
  }),
}));

vi.mock("@/stores/settings", () => ({
  useSettingsStore: () => ({
    agentMode: "agent",
    runtimeLlmConfig: vi.fn(async () => ({ provider: "test" })),
  }),
}));

vi.mock("@/stores/preview", () => ({
  usePreviewStore: () => ({ tabs: [], activeTabId: null }),
}));

const { getChatRunner } = await import("@/shell/chat-runner");
const { useChatStore } = await import("@/stores/chat");

function emit(event: string, payload: Record<string, unknown>) {
  const handler = handlers[event];
  if (!handler) throw new Error(`no listener registered for ${event}`);
  handler({ payload });
}

describe("chat-runner stream projection", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    sendMessage.mockClear();
  });

  it("subscribes to every sidecar stream channel", async () => {
    await getChatRunner().ensureListening();

    expect(Object.keys(handlers).sort()).toEqual([
      "agent:stream:delta",
      "agent:stream:done",
      "agent:stream:error",
      "agent:stream:ready",
      "agent:stream:thinking",
      "agent:stream:tool_call",
      "agent:stream:tool_result",
      "agent:stream:usage",
      "agent:tool_approval_required",
    ]);
  });

  it("projects usage events onto the run usage rings", async () => {
    const chat = useChatStore();
    await getChatRunner().sendMessage("hi");

    const usage: TokenUsage = {
      input_tokens: 120,
      output_tokens: 30,
      total_tokens: 150,
      ttft_ms: 640,
      duration_ms: 1800,
      context_used: 2000,
      context_max: 128_000,
    };
    emit("agent:stream:usage", { usage });

    expect(chat.runUsage?.total_tokens).toBe(150);
    expect(chat.runUsage?.ttft_ms).toBe(640);
    expect(chat.currentTokenCount).toBe(150);
  });

  it("keeps final usage from the done event", async () => {
    const chat = useChatStore();
    await getChatRunner().sendMessage("hi");

    emit("agent:stream:done", { usage: { total_tokens: 900, ttft_ms: 120 } });

    expect(chat.runUsage?.total_tokens).toBe(900);
    expect(chat.isAgentRunning).toBe(false);
  });

  it("correlates tool results with tool calls by callId", async () => {
    const chat = useChatStore();
    await getChatRunner().sendMessage("hi");

    emit("agent:stream:tool_call", {
      callId: "call-1",
      name: "read_file",
      input: { path: "a.ts" },
    });
    emit("agent:stream:tool_result", {
      callId: "call-1",
      output: "file body",
      isError: false,
    });

    const progress = chat.messages.find((message) => message.role === "tool");
    expect(progress?.toolCalls?.some((call) => call.id === "call-1")).toBe(true);
    expect(progress?.toolResults?.[0]).toMatchObject({
      id: "call-1",
      output: "file body",
    });
  });

  it("adds thinking once and surfaces approval requests as steps", async () => {
    const chat = useChatStore();
    await getChatRunner().sendMessage("hi");

    emit("agent:stream:thinking", { text: "…" });
    emit("agent:stream:thinking", { text: "…" });
    emit("agent:tool_approval_required", {
      callId: "call-9",
      name: "run_shell",
      reason: "shell command needs approval",
      cmd: "rm",
      args: ["-rf", "tmp"],
    });

    const progress = chat.messages.find((message) => message.role === "tool");
    const names = progress?.toolCalls?.map((call) => call.name) ?? [];
    expect(names.filter((name) => name === "agent_thinking")).toHaveLength(1);
    const approval = progress?.toolCalls?.find(
      (call) => call.name === "tool_approval_required",
    );
    expect(approval?.id).toBe("call-9");
    expect(approval?.input.reason).toBe("shell command needs approval");
  });

  it("segments a run into time-ordered text and tool messages", async () => {
    const chat = useChatStore();
    await getChatRunner().sendMessage("装一下 playwright");

    emit("agent:stream:delta", { delta: "先装依赖。" });
    emit("agent:stream:tool_call", { callId: "c1", name: "bash", input: { cmd: "pnpm add" } });
    emit("agent:stream:tool_result", { callId: "c1", output: "added 1 package" });
    emit("agent:stream:delta", { delta: "装好了。" });
    emit("agent:stream:tool_call", { callId: "c2", name: "bash", input: { cmd: "npx pw" } });
    emit("agent:stream:done", {});

    const turnMessages = chat.messages.filter((message) => message.turnId);
    // agent_start tools → text → tools → text → tools
    expect(turnMessages.map((message) => message.role)).toEqual([
      "tool",
      "assistant",
      "tool",
      "assistant",
      "tool",
    ]);
    expect(turnMessages[1]?.content).toBe("先装依赖。");
    expect(turnMessages[3]?.content).toBe("装好了。");
    const turnIds = new Set(turnMessages.map((message) => message.turnId));
    expect(turnIds.size).toBe(1);
  });

  it("routes a late tool result back to the segment that called it", async () => {
    const chat = useChatStore();
    await getChatRunner().sendMessage("hi");

    emit("agent:stream:tool_call", { callId: "c1", name: "bash", input: {} });
    // Narration resumes, opening a text segment, and only then the result lands.
    emit("agent:stream:delta", { delta: "还在等命令返回。" });
    emit("agent:stream:tool_result", { callId: "c1", output: "done" });

    const toolMessages = chat.messages.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.toolResults?.[0]).toMatchObject({ id: "c1", output: "done" });
  });

  it("stamps the turn end so the collapsed header can show a duration", async () => {
    const chat = useChatStore();
    await getChatRunner().sendMessage("hi");

    emit("agent:stream:delta", { delta: "好了" });
    emit("agent:stream:done", {});

    const turnMessages = chat.messages.filter((message) => message.turnId);
    const last = turnMessages[turnMessages.length - 1];
    expect(last?.endedAt).toBeGreaterThan(0);
    expect(last?.isStreaming).toBe(false);
  });

  it("reports a failure as text even when tools were the last segment", async () => {
    const chat = useChatStore();
    await getChatRunner().sendMessage("hi");

    emit("agent:stream:tool_call", { callId: "c1", name: "bash", input: {} });
    emit("agent:stream:error", { message: "boom" });

    const last = chat.messages[chat.messages.length - 1];
    expect(last?.role).toBe("assistant");
    expect(last?.isError).toBe(true);
    expect(chat.isAgentRunning).toBe(false);
  });
});
