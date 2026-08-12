import { describe, expect, it, vi } from "vitest";
import type { LLMAdapter } from "../src/adapters/base.js";
import { streamAgent } from "../src/agent/loop.js";
import { MemoryTracker } from "../src/memory/index.js";
import type { Message, StreamEvent } from "../src/types/index.js";
import { events } from "./agent-context-test-helpers.js";

describe("streamAgent context updates", () => {
  it("reports managed history across tool loops", async () => {
    const requests: Message[][] = [];
    let call = 0;
    const adapter: LLMAdapter = {
      complete: vi.fn(),
      stream: (request) => {
        requests.push([...request.messages]);
        call++;
        if (call === 1) {
          return events([
            {
              type: "tool_call",
              id: "tool-1",
              name: "lookup",
              arguments: JSON.stringify({ q: "auth" }),
            },
            { type: "done", stop_reason: "tool_use" },
          ]);
        }
        return events([
          { type: "text", text: "done" },
          { type: "done", stop_reason: "end_turn" },
        ]);
      },
    };

    let managed: Message[] = [];

    const output = await streamAgent(
      "check auth",
      {
        adapter,
        model: "claude-sonnet-4-6",
        tools: [
          {
            name: "lookup",
            description: "lookup",
            parameters: { type: "object", properties: {} },
          },
        ],
        onToolCall: () => "auth result",
        onContextUpdate: (messages) => {
          managed = messages;
        },
      },
      () => {},
    );

    expect(output).toBe("done");
    expect(requests).toHaveLength(2);
    expect(requests[1]!.some((m) => m.role === "tool" && m.content === "auth result")).toBe(true);
    expect(managed.some((m) => m.role === "tool" && m.content === "auth result")).toBe(true);
    expect(managed[managed.length - 1]).toMatchObject({ role: "assistant", content: "done" });
  });

  it("replays signed thinking from the exact provider message in tool loops", async () => {
    const requests: Message[][] = [];
    let call = 0;
    const adapter: LLMAdapter = {
      complete: vi.fn(),
      stream: (request) => {
        requests.push([...request.messages]);
        call++;
        if (call === 1) {
          return events([
            { type: "thinking", text: "I need to inspect the file." },
            {
              type: "tool_call",
              id: "tool-thinking",
              name: "read_file",
              arguments: JSON.stringify({ path: "/tmp/test" }),
            },
            {
              type: "done",
              stop_reason: "tool_use",
              message: {
                role: "assistant",
                content: [
                  {
                    type: "thinking",
                    thinking: "I need to inspect the file.",
                    signature: "sig-deepseek-v4-flash",
                  },
                  {
                    type: "tool_call",
                    id: "tool-thinking",
                    name: "read_file",
                    arguments: JSON.stringify({ path: "/tmp/test" }),
                  },
                ],
              },
            },
          ]);
        }
        return events([
          { type: "text", text: "inspection complete" },
          { type: "done", stop_reason: "end_turn" },
        ]);
      },
    };

    await streamAgent(
      "inspect",
      {
        adapter,
        model: "deepseek-v4-flash",
        tools: [
          {
            name: "read_file",
            description: "read file",
            parameters: { type: "object", properties: {} },
          },
        ],
        onToolCall: () => "file contents",
      },
      () => {},
    );

    const assistant = requests[1]!.find(
      (message) => message.role === "assistant",
    );
    expect(assistant?.content).toEqual([
      {
        type: "thinking",
        thinking: "I need to inspect the file.",
        signature: "sig-deepseek-v4-flash",
      },
      {
        type: "tool_call",
        id: "tool-thinking",
        name: "read_file",
        arguments: '{"path":"/tmp/test"}',
      },
    ]);
  });

  it("returns only the final no-tool assistant text from a tool loop", async () => {
    let call = 0;
    const adapter: LLMAdapter = {
      complete: vi.fn(),
      stream: () => {
        call++;
        if (call === 1) {
          return events([
            { type: "text", text: "我先检查项目状态。" },
            {
              type: "tool_call",
              id: "tool-1",
              name: "list_dir",
              arguments: JSON.stringify({ path: "." }),
            },
            { type: "done", stop_reason: "end_turn" },
          ]);
        }
        return events([
          { type: "text", text: "当前状态已明确。" },
          { type: "done", stop_reason: "end_turn" },
        ]);
      },
    };

    const output = await streamAgent(
      "看下状态",
      {
        adapter,
        model: "claude-sonnet-4-6",
        tools: [
          {
            name: "list_dir",
            description: "list files",
            parameters: { type: "object", properties: {} },
          },
        ],
        onToolCall: () => "files",
      },
      () => {},
    );

    expect(output).toBe("当前状态已明确。");
  });

  it("injects selected memory as a stable message instead of changing system", async () => {
    const requests: Array<{ system: string | undefined; messages: Message[] }> = [];
    const adapter: LLMAdapter = {
      complete: vi.fn(),
      stream: (request) => {
        requests.push({ system: request.system, messages: request.messages });
        return events([
          { type: "text", text: "used memory" },
          { type: "done", stop_reason: "end_turn" },
        ]);
      },
    };

    let managed: Message[] = [];

    await streamAgent(
      "check project rules",
      {
        adapter,
        model: "claude-sonnet-4-6",
        system: "base system",
        memoryTracker: new MemoryTracker({ memoryDir: "/tmp/vera-test-memory" }),
        scannedMemoryFiles: [
          {
            path: "/tmp/vera-test-memory/project.md",
            filename: "project.md",
            type: "project",
            description: "project rules",
            mtimeMs: 1,
          },
        ],
        onMemorySelected: () => "stable memory block",
        onContextUpdate: (messages) => {
          managed = messages;
        },
      },
      () => {},
    );

    expect(requests[0]!.system).toContain("base system");
    expect(requests[0]!.system).toContain("Use them continuously until the task is fully complete");
    expect(requests[0]!.system).toContain("inspect the current workspace with read-only tools first");
    expect(requests[0]!.system).not.toContain("stable memory block");
    expect(requests[0]!.messages[0]!.role).toBe("user");
    expect(String(requests[0]!.messages[0]!.content)).toContain("<dynamic-memory-context>");
    expect(String(requests[0]!.messages[0]!.content)).toContain("stable memory block");
    expect(managed[0]!.content).toBe("check project rules");
  });

  it("continues when tool calls are present even if stop_reason is end_turn", async () => {
    const requests: Message[][] = [];
    let call = 0;
    const adapter: LLMAdapter = {
      complete: vi.fn(),
      stream: (request) => {
        requests.push([...request.messages]);
        call++;
        if (call === 1) {
          return events([
            {
              type: "tool_call",
              id: "tool-1",
              name: "list_dir",
              arguments: JSON.stringify({ path: "." }),
            },
            { type: "done", stop_reason: "end_turn" },
          ]);
        }
        return events([
          { type: "text", text: "当前状态清楚，下一步应该提交改动。" },
          { type: "done", stop_reason: "end_turn" },
        ]);
      },
    };

    const output = await streamAgent(
      "接下来做什么",
      {
        adapter,
        model: "claude-sonnet-4-6",
        tools: [
          {
            name: "list_dir",
            description: "list files",
            parameters: { type: "object", properties: {} },
          },
        ],
        onToolCall: () => "files",
      },
      () => {},
    );

    expect(requests).toHaveLength(2);
    expect(requests[1]!.some((m) => m.role === "tool" && m.content === "files")).toBe(true);
    expect(output).toContain("当前状态清楚");
  });

  it("does not stop after ten consecutive tool turns by default", async () => {
    const requests: Message[][] = [];
    let call = 0;
    const adapter: LLMAdapter = {
      complete: vi.fn(),
      stream: (request) => {
        requests.push([...request.messages]);
        call++;
        if (call <= 11) {
          return events([
            {
              type: "tool_call",
              id: `tool-${call}`,
              name: "lookup",
              arguments: JSON.stringify({ n: call }),
            },
            { type: "done", stop_reason: "tool_use" },
          ]);
        }
        return events([
          { type: "text", text: "已经完成连续检查。" },
          { type: "done", stop_reason: "end_turn" },
        ]);
      },
    };

    const output = await streamAgent(
      "连续检查",
      {
        adapter,
        model: "claude-sonnet-4-6",
        tools: [
          {
            name: "lookup",
            description: "lookup",
            parameters: { type: "object", properties: {} },
          },
        ],
        onToolCall: () => "ok",
      },
      () => {},
    );

    expect(requests).toHaveLength(12);
    expect(output).toBe("已经完成连续检查。");
  });

  it("stops when no tool calls are present even if stop_reason is tool_use", async () => {
    const requests: Message[][] = [];
    const adapter: LLMAdapter = {
      complete: vi.fn(),
      stream: (request) => {
        requests.push([...request.messages]);
        return events([
          { type: "text", text: "没有工具调用，直接结束。" },
          { type: "done", stop_reason: "tool_use" },
        ]);
      },
    };

    const output = await streamAgent(
      "检查状态",
      {
        adapter,
        model: "claude-sonnet-4-6",
        tools: [
          {
            name: "list_dir",
            description: "list files",
            parameters: { type: "object", properties: {} },
          },
        ],
        onToolCall: () => "should not run",
      },
      () => {},
    );

    expect(requests).toHaveLength(1);
    expect(output).toContain("没有工具调用");
  });

  it("continues once when a tool result is followed by an empty assistant response", async () => {
    const requests: Message[][] = [];
    let call = 0;
    const adapter: LLMAdapter = {
      complete: vi.fn(),
      stream: (request) => {
        requests.push([...request.messages]);
        call++;
        if (call === 1) {
          return events([
            {
              type: "tool_call",
              id: "tool-1",
              name: "read_file",
              arguments: JSON.stringify({ path: "../docs/roadmap.md" }),
            },
            { type: "done", stop_reason: "tool_use" },
          ]);
        }
        if (call === 2) {
          return events([
            { type: "done", stop_reason: "end_turn" },
          ]);
        }
        return events([
          { type: "text", text: "路径读取失败，需要改用正确路径继续检查。" },
          { type: "done", stop_reason: "end_turn" },
        ]);
      },
    };

    const output = await streamAgent(
      "查看 roadmap",
      {
        adapter,
        model: "claude-sonnet-4-6",
        tools: [
          {
            name: "read_file",
            description: "read file",
            parameters: { type: "object", properties: {} },
          },
        ],
        onToolCall: () => "NOT_FOUND\nFile not found: ../docs/roadmap.md",
      },
      () => {},
    );

    expect(requests).toHaveLength(3);
    expect(requests[2]!.at(-1)).toMatchObject({
      role: "user",
      content: expect.stringContaining("last response was empty"),
    });
    expect(output).toContain("路径读取失败");
  });

});
