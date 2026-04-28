import { describe, expect, it, vi } from "vitest";
import type { LLMAdapter } from "../src/adapters/base.js";
import { streamAgent } from "../src/agent/loop.js";
import { MemoryTracker } from "../src/memory/index.js";
import type { Message, StreamEvent } from "../src/types/index.js";

async function* events(items: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const item of items) yield item;
}

describe("streamAgent context updates", () => {
  it("reports managed history across tool loops", async () => {
    const requests: Message[][] = [];
    let call = 0;
    const adapter: LLMAdapter = {
      complete: vi.fn(),
      stream: (request) => {
        requests.push(request.messages);
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

    expect(requests[0]!.system).toBe("base system");
    expect(requests[0]!.messages[0]!.role).toBe("user");
    expect(String(requests[0]!.messages[0]!.content)).toContain("<dynamic-memory-context>");
    expect(String(requests[0]!.messages[0]!.content)).toContain("stable memory block");
    expect(managed[0]!.content).toBe("check project rules");
  });
});
