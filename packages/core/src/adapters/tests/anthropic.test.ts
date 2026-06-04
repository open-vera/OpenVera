/**
 * Unit tests for AnthropicAdapter.
 * Covers: construction, complete(), stream(), listModels(), and all internal mappings.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  CompletionRequest,
  CompletionResponse,
  StreamEvent,
  Message,
  ContentPart,
} from "../../types/index.js";

// ── Mock @anthropic-ai/sdk ────────────────────────────────────────────────────
const mockCreate = vi.hoisted(() => vi.fn());
const mockStream = vi.hoisted(() => vi.fn());
const mockListModels = vi.hoisted(() => vi.fn());
const MockAnthropic = vi.hoisted(() =>
  vi.fn(function (this: Record<string, unknown>, _config: Record<string, unknown>) {
    this.messages = {
      create: mockCreate,
      stream: mockStream,
    };
    this.models = {
      list: mockListModels,
    };
    return this;
  })
);

vi.mock("@anthropic-ai/sdk", () => ({
  default: MockAnthropic,
}));

// Import after mock
import { AnthropicAdapter } from "../anthropic.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTextResponse(opts: {
  text?: string;
  stop_reason?: "end_turn" | "tool_use";
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
} = {}) {
  return {
    id: "msg_1",
    model: "claude-sonnet-4-20250514",
    type: "message" as const,
    role: "assistant" as const,
    content: [{ type: "text" as const, text: opts.text ?? "Hello" }],
    stop_reason: opts.stop_reason ?? "end_turn",
    usage: {
      input_tokens: opts.input_tokens ?? 10,
      output_tokens: opts.output_tokens ?? 5,
      cache_creation_input_tokens: opts.cache_creation_input_tokens ?? null,
      cache_read_input_tokens: opts.cache_read_input_tokens ?? null,
    },
  };
}

function makeToolUseResponse() {
  return {
    id: "msg_2",
    model: "claude-sonnet-4-20250514",
    type: "message" as const,
    role: "assistant" as const,
    content: [
      {
        type: "tool_use" as const,
        id: "toolu_01",
        name: "read_file",
        input: { path: "/tmp/test" },
      },
    ],
    stop_reason: "tool_use" as const,
    usage: { input_tokens: 15, output_tokens: 20 },
  };
}

function makeThinkingResponse() {
  return {
    id: "msg_3",
    model: "claude-sonnet-4-20250514",
    type: "message" as const,
    role: "assistant" as const,
    content: [
      { type: "thinking" as const, thinking: "Let me think..." },
      { type: "text" as const, text: "Answer" },
    ],
    stop_reason: "end_turn" as const,
    usage: { input_tokens: 30, output_tokens: 40 },
  };
}

/** Create a mock async-iterable stream with a finalMessage() method */
function makeMockStream(
  events: Array<Record<string, unknown>>,
  finalMessage: Record<string, unknown>
) {
  const finalPromise = Promise.resolve(finalMessage);
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      let closed = false;
      return {
        next: async () => {
          if (closed) return { done: true as const, value: undefined };
          if (i < events.length) {
            return { value: events[i++], done: false };
          }
          closed = true;
          return { done: true as const, value: undefined };
        },
      };
    },
    finalMessage: () => finalPromise,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("AnthropicAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Construction ─────────────────────────────────────────────────────────

  describe("constructor", () => {
    it("should pass apiKey and baseUrl to Anthropic client", () => {
      new AnthropicAdapter("key-123", "https://api.example.com");
      expect(MockAnthropic).toHaveBeenCalledWith({
        apiKey: "key-123",
        baseURL: "https://api.example.com",
        defaultHeaders: undefined,
      });
    });

    it("should pass undefined for omitted apiKey and baseUrl", () => {
      new AnthropicAdapter();
      expect(MockAnthropic).toHaveBeenCalledWith({
        apiKey: undefined,
        baseURL: undefined,
        defaultHeaders: undefined,
      });
    });

    it("should pass undefined baseURL when omitted", () => {
      new AnthropicAdapter("key-abc");
      expect(MockAnthropic).toHaveBeenCalledWith({
        apiKey: "key-abc",
        baseURL: undefined,
        defaultHeaders: undefined,
      });
    });

    it("should pass headers to Anthropic client", () => {
      const headers = { "X-Test": "enabled" };
      new AnthropicAdapter("key-abc", "https://api.example.com", headers);
      expect(MockAnthropic).toHaveBeenCalledWith({
        apiKey: "key-abc",
        baseURL: "https://api.example.com",
        defaultHeaders: headers,
      });
    });
  });

  // ── complete() ───────────────────────────────────────────────────────────

  describe("complete", () => {
    it("should return a text response", async () => {
      mockCreate.mockResolvedValueOnce(makeTextResponse({ text: "Hi" }));

      const adapter = new AnthropicAdapter("k");
      const req: CompletionRequest = {
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "Hello" }],
      };
      const res = await adapter.complete(req);

      expect(res.message.content).toBe("Hi");
      expect(res.stop_reason).toBe("end_turn");
      expect(res.usage).toEqual({
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: undefined,
        cache_read_input_tokens: undefined,
      });
    });

    it("should map tool_use stop_reason to tool_use", async () => {
      mockCreate.mockResolvedValueOnce(makeToolUseResponse());

      const adapter = new AnthropicAdapter("k");
      const req: CompletionRequest = {
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "read /tmp/test" }],
      };
      const res = await adapter.complete(req);

      expect(res.stop_reason).toBe("tool_use");
      // Content should be ContentPart[] when multiple blocks or tool_use
      const parts = res.message.content as ContentPart[];
      expect(parts[0]).toEqual({
        type: "tool_call",
        id: "toolu_01",
        name: "read_file",
        arguments: '{"path":"/tmp/test"}',
      });
    });

    it("should handle thinking content blocks", async () => {
      mockCreate.mockResolvedValueOnce(makeThinkingResponse());

      const adapter = new AnthropicAdapter("k");
      const req: CompletionRequest = {
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "Q" }],
      };
      const res = await adapter.complete(req);

      const parts = res.message.content as ContentPart[];
      expect(parts).toHaveLength(2);
      expect(parts[0]).toEqual({ type: "thinking", thinking: "Let me think..." });
      expect(parts[1]).toEqual({ type: "text", text: "Answer" });
    });

    it("should default max_tokens to 8096", async () => {
      mockCreate.mockResolvedValueOnce(makeTextResponse());

      const adapter = new AnthropicAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ max_tokens: 8096 }),
        expect.anything()
      );
    });

    it("should pass explicit max_tokens", async () => {
      mockCreate.mockResolvedValueOnce(makeTextResponse());

      const adapter = new AnthropicAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        max_tokens: 100,
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ max_tokens: 100 }),
        expect.anything()
      );
    });

    it("should pass signal", async () => {
      mockCreate.mockResolvedValueOnce(makeTextResponse());
      const ac = new AbortController();

      const adapter = new AnthropicAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        signal: ac.signal,
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.anything(),
        { signal: ac.signal }
      );
    });

    it("should propagate API errors", async () => {
      const err = new Error("Rate limited");
      mockCreate.mockRejectedValueOnce(err);

      const adapter = new AnthropicAdapter("k");
      await expect(
        adapter.complete({ model: "m", messages: [{ role: "user", content: "x" }] })
      ).rejects.toThrow("Rate limited");
    });

    it("should include cache tokens when present", async () => {
      mockCreate.mockResolvedValueOnce(
        makeTextResponse({
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 200,
        })
      );

      const adapter = new AnthropicAdapter("k");
      const res = await adapter.complete({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      });

      expect(res.usage?.cache_creation_input_tokens).toBe(100);
      expect(res.usage?.cache_read_input_tokens).toBe(200);
    });
  });

  // ── stream() ─────────────────────────────────────────────────────────────

  describe("stream", () => {
    it("should yield text deltas", async () => {
      mockStream.mockReturnValue(
        makeMockStream(
          [
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
          ],
          makeTextResponse()
        )
      );

      const adapter = new AnthropicAdapter("k");
      const events: StreamEvent[] = [];
      for await (const e of adapter.stream({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      })) {
        events.push(e);
      }

      expect(events).toContainEqual({ type: "text", text: "Hi" });
    });

    it("should yield thinking deltas", async () => {
      mockStream.mockReturnValue(
        makeMockStream(
          [
            { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Hmm..." } },
          ],
          makeTextResponse()
        )
      );

      const adapter = new AnthropicAdapter("k");
      const events: StreamEvent[] = [];
      for await (const e of adapter.stream({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      })) {
        events.push(e);
      }

      expect(events).toContainEqual({ type: "thinking", text: "Hmm..." });
    });

    it("should accumulate tool_use arguments from input_json_delta", async () => {
      mockStream.mockReturnValue(
        makeMockStream(
          [
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "tool_use", id: "t1", name: "search" },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: '{"q":' },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: '"hello"}' },
            },
          ],
          {
            ...makeTextResponse(),
            stop_reason: "tool_use",
          }
        )
      );

      const adapter = new AnthropicAdapter("k");
      const events: StreamEvent[] = [];
      for await (const e of adapter.stream({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      })) {
        events.push(e);
      }

      expect(events).toContainEqual({
        type: "tool_call",
        id: "t1",
        name: "search",
        arguments: '{"q":"hello"}',
      });
    });

    it("should yield done with end_turn stop_reason", async () => {
      mockStream.mockReturnValue(
        makeMockStream([], {
          ...makeTextResponse(),
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 3 },
        })
      );

      const adapter = new AnthropicAdapter("k");
      const events: StreamEvent[] = [];
      for await (const e of adapter.stream({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      })) {
        events.push(e);
      }

      const done = events.find((e) => e.type === "done");
      expect(done).toBeDefined();
      expect(done!.stop_reason).toBe("end_turn");
      expect(done!.usage).toEqual({ input_tokens: 5, output_tokens: 3 });
    });

    it("should yield done with tool_use stop_reason", async () => {
      mockStream.mockReturnValue(
        makeMockStream([], {
          ...makeTextResponse(),
          stop_reason: "tool_use",
          usage: { input_tokens: 5, output_tokens: 3 },
        })
      );

      const adapter = new AnthropicAdapter("k");
      const events: StreamEvent[] = [];
      for await (const e of adapter.stream({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      })) {
        events.push(e);
      }

      const done = events.find((e) => e.type === "done");
      expect(done!.stop_reason).toBe("tool_use");
    });

    it("should include thinking_budget in request when set", async () => {
      mockStream.mockReturnValue(makeMockStream([], makeTextResponse()));

      const adapter = new AnthropicAdapter("k");
      const events: StreamEvent[] = [];
      for await (const e of adapter.stream({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        thinking_budget: 4000,
      })) {
        events.push(e);
      }

      expect(mockStream).toHaveBeenCalledWith(
        expect.objectContaining({
          thinking: { type: "enabled", budget_tokens: 4000 },
        }),
        expect.anything()
      );
      // Make sure done is yielded
      expect(events.some((e) => e.type === "done")).toBe(true);
    });

    it("should not include thinking when thinking_budget omitted", async () => {
      mockStream.mockReturnValue(makeMockStream([], makeTextResponse()));

      const adapter = new AnthropicAdapter("k");
      for await (const e of adapter.stream({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      })) {
        // consume
      }

      const callArgs = mockStream.mock.calls[0][0] as Record<string, unknown>;
      expect(callArgs.thinking).toBeUndefined();
    });

    it("should propagate stream errors", async () => {
      const err = new Error("Connection reset");
      mockStream.mockReturnValue({
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              throw err;
            },
          };
        },
        finalMessage: vi.fn(),
      });

      const adapter = new AnthropicAdapter("k");
      const iter = adapter.stream({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      });

      await expect(async () => {
        for await (const _ of iter) {
          /* should not reach */
        }
      }).rejects.toThrow("Connection reset");
    });

    it("should handle cache tokens being undefined in final", async () => {
      mockStream.mockReturnValue(
        makeMockStream([], {
          ...makeTextResponse(),
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      );

      const adapter = new AnthropicAdapter("k");
      const events: StreamEvent[] = [];
      for await (const e of adapter.stream({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      })) {
        events.push(e);
      }

      const done = events.find((e) => e.type === "done");
      expect(done!.usage?.cache_creation_input_tokens).toBeUndefined();
      expect(done!.usage?.cache_read_input_tokens).toBeUndefined();
    });

    it("should handle multiple tool calls", async () => {
      mockStream.mockReturnValue(
        makeMockStream(
          [
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "tool_use", id: "a", name: "tool_a" },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: "{}" },
            },
            {
              type: "content_block_start",
              index: 1,
              content_block: { type: "tool_use", id: "b", name: "tool_b" },
            },
            {
              type: "content_block_delta",
              index: 1,
              delta: { type: "input_json_delta", partial_json: "[]" },
            },
          ],
          { ...makeTextResponse(), stop_reason: "tool_use" }
        )
      );

      const adapter = new AnthropicAdapter("k");
      const events: StreamEvent[] = [];
      for await (const e of adapter.stream({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      })) {
        events.push(e);
      }

      const toolCalls = events.filter((e) => e.type === "tool_call");
      expect(toolCalls).toHaveLength(2);
      expect(toolCalls[0]).toMatchObject({ id: "a", name: "tool_a" });
      expect(toolCalls[1]).toMatchObject({ id: "b", name: "tool_b" });
    });

    it("should handle input_json_delta with no matching toolCalls entry", async () => {
      mockStream.mockReturnValue(
        makeMockStream(
          [
            {
              type: "content_block_delta",
              index: 99,
              delta: { type: "input_json_delta", partial_json: "ignored" },
            },
          ],
          makeTextResponse()
        )
      );

      const adapter = new AnthropicAdapter("k");
      const events: StreamEvent[] = [];
      for await (const e of adapter.stream({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      })) {
        events.push(e);
      }

      // No tool_call should be emitted for index 99
      expect(events.filter((e) => e.type === "tool_call")).toHaveLength(0);
    });

    it("should pass signal to stream", async () => {
      mockStream.mockReturnValue(makeMockStream([], makeTextResponse()));
      const ac = new AbortController();

      const adapter = new AnthropicAdapter("k");
      for await (const e of adapter.stream({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        signal: ac.signal,
      })) {
        // consume
      }

      expect(mockStream).toHaveBeenCalledWith(
        expect.anything(),
        { signal: ac.signal }
      );
    });
  });

  // ── listModels() ─────────────────────────────────────────────────────────

  describe("listModels", () => {
    it("should map model list from Anthropic API", async () => {
      mockListModels.mockResolvedValueOnce({
        data: [
          {
            id: "claude-sonnet-4-20250514",
            display_name: "Claude Sonnet 4",
            created_at: "2025-05-14T00:00:00Z",
          },
          {
            id: "claude-opus-4-20250514",
            display_name: "Claude Opus 4",
            created_at: "2025-05-14T00:00:00Z",
          },
        ],
      });

      const adapter = new AnthropicAdapter("k");
      const models = await adapter.listModels();

      expect(models).toHaveLength(2);
      expect(models[0].id).toBe("claude-sonnet-4-20250514");
      expect(models[0].display_name).toBe("Claude Sonnet 4");
      expect(models[0].created).toBeGreaterThan(0);
    });

    it("should handle empty model list", async () => {
      mockListModels.mockResolvedValueOnce({ data: [] });

      const adapter = new AnthropicAdapter("k");
      const models = await adapter.listModels();
      expect(models).toHaveLength(0);
    });
  });

  // ── toAnthropicMessages (coverage via complete) ───────────────────────────

  describe("message conversion (via complete)", () => {
    it("should filter out system messages", async () => {
      mockCreate.mockResolvedValueOnce(makeTextResponse());

      const adapter = new AnthropicAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [
          { role: "system", content: "You are helpful" },
          { role: "user", content: "Hi" },
        ],
      });

      const callArgs = mockCreate.mock.calls[0][0] as { messages: Array<{ role: string }> };
      const roles = callArgs.messages.map((m) => m.role);
      expect(roles).not.toContain("system");
    });

    it("should convert tool messages to user with tool_result", async () => {
      mockCreate.mockResolvedValueOnce(makeTextResponse());

      const adapter = new AnthropicAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [
          { role: "user", content: "Search" },
          {
            role: "tool",
            tool_call_id: "t1",
            content: "result data",
          },
        ],
      });

      const callArgs = mockCreate.mock.calls[0][0] as { messages: Array<Record<string, unknown>> };
      const toolMsg = callArgs.messages.find(
        (m) => Array.isArray(m.content) && (m.content as Array<Record<string, unknown>>)[0]?.type === "tool_result"
      ) as { content: Array<Record<string, unknown>> };
      expect(toolMsg!.content[0]).toMatchObject({
        type: "tool_result",
        tool_use_id: "t1",
        content: "result data",
      });
    });

    it("should handle tool message with array content", async () => {
      mockCreate.mockResolvedValueOnce(makeTextResponse());

      const adapter = new AnthropicAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [
          {
            role: "tool",
            tool_call_id: "t2",
            content: [{ type: "text", text: "multi" }],
          },
        ],
      });

      const callArgs = mockCreate.mock.calls[0][0] as { messages: Array<Record<string, unknown>> };
      const toolMsg = callArgs.messages.find(
        (m) => Array.isArray(m.content)
      ) as { content: Array<Record<string, unknown>> };
      // Array content on tool messages is stringified to ""
      expect(toolMsg.content[0].content).toBe("");
    });

    it("should convert assistant messages with tool_call ContentParts", async () => {
      mockCreate.mockResolvedValueOnce(makeTextResponse());

      const adapter = new AnthropicAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_call",
                id: "tc1",
                name: "read",
                arguments: '{"path":"/f"}',
              },
            ],
          },
          { role: "user", content: "ok" },
        ],
      });

      const callArgs = mockCreate.mock.calls[0][0] as { messages: Array<Record<string, unknown>> };
      const asstMsg = callArgs.messages.find(
        (m) => m.role === "assistant"
      ) as { content: Array<Record<string, unknown>> };
      expect(asstMsg.content[0]).toMatchObject({
        type: "tool_use",
        id: "tc1",
        name: "read",
      });
      expect(asstMsg.content[0].input).toEqual({ path: "/f" });
    });

    it("should handle empty content array in message", async () => {
      mockCreate.mockResolvedValueOnce(makeTextResponse());

      const adapter = new AnthropicAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [
          { role: "user", content: [] as unknown as string },
        ],
      });

      // Should not throw; the empty array will result in empty content
      expect(mockCreate).toHaveBeenCalled();
    });
  });

  // ── toAnthropicTools (coverage via complete) ──────────────────────────────

  describe("tool conversion (via complete)", () => {
    it("should pass tools to the API", async () => {
      mockCreate.mockResolvedValueOnce(makeTextResponse());

      const adapter = new AnthropicAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        tools: [
          {
            name: "search",
            description: "Search the web",
            parameters: {
              type: "object",
              properties: {
                query: { type: "string", description: "Search query" },
              },
              required: ["query"],
            },
          },
        ],
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: [
            {
              name: "search",
              description: "Search the web",
              input_schema: {
                type: "object",
                properties: { query: { type: "string", description: "Search query" } },
                required: ["query"],
              },
            },
          ],
        }),
        expect.anything()
      );
    });

    it("should not send tools key when tools empty", async () => {
      mockCreate.mockResolvedValueOnce(makeTextResponse());

      const adapter = new AnthropicAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        tools: [],
      });

      const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>;
      expect(callArgs.tools).toBeUndefined();
    });

    it("should not send tools key when tools undefined", async () => {
      mockCreate.mockResolvedValueOnce(makeTextResponse());

      const adapter = new AnthropicAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      });

      const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>;
      expect(callArgs.tools).toBeUndefined();
    });
  });

  // ── fromAnthropicResponse edge cases ─────────────────────────────────────

  describe("fromAnthropicResponse edge cases", () => {
    it("should handle response with mixed text and tool_use content", async () => {
      mockCreate.mockResolvedValueOnce({
        id: "msg_mix",
        model: "m",
        type: "message" as const,
        role: "assistant" as const,
        content: [
          { type: "text" as const, text: "Using tool..." },
          {
            type: "tool_use" as const,
            id: "tid",
            name: "calc",
            input: { expr: "1+1" },
          },
        ],
        stop_reason: "tool_use" as const,
        usage: { input_tokens: 10, output_tokens: 20 },
      });

      const adapter = new AnthropicAdapter("k");
      const res = await adapter.complete({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      });

      // Multiple parts → content should be ContentPart[], not string
      const parts = res.message.content as ContentPart[];
      expect(Array.isArray(parts)).toBe(true);
      expect(parts).toHaveLength(2);
      expect(parts[0].type).toBe("text");
      expect(parts[1].type).toBe("tool_call");
    });
  });

  // ── flatMap fallback branches ───────────────────────────────────────────

  describe("flatMap fallback (unrecognized content types)", () => {
    it("should skip unrecognized ContentPart types in toAnthropicMessages", async () => {
      mockCreate.mockResolvedValueOnce(makeTextResponse());

      const adapter = new AnthropicAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hello" },
              { type: "image_url" as "text", image_url: { url: "http://example.com/img.png" } },
            ],
          },
        ],
      });

      // Should not throw; unrecognized parts are filtered via return []
      expect(mockCreate).toHaveBeenCalled();
    });

    it("should skip unrecognized response block types in fromAnthropicResponse", async () => {
      mockCreate.mockResolvedValueOnce({
        id: "msg_unknown",
        model: "m",
        type: "message" as const,
        role: "assistant" as const,
        content: [
          { type: "text" as const, text: "OK" },
          { type: "unknown_block" as "text" },
        ],
        stop_reason: "end_turn" as const,
        usage: { input_tokens: 1, output_tokens: 1 },
      });

      const adapter = new AnthropicAdapter("k");
      const res = await adapter.complete({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      });

      // Unknown block type is skipped; only text part is included.
      // Single text part → string content
      expect(res.message.content).toBe("OK");
    });
  });
});
