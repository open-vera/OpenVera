/**
 * Unit tests for OpenAIAdapter.
 * Covers: construction, complete(), stream(), listModels(), and all internal mappings.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  CompletionRequest,
  StreamEvent,
  ContentPart,
} from "../../types/index.js";

// ── Mock openai ──────────────────────────────────────────────────────────────
const mockCreate = vi.hoisted(() => vi.fn());
const mockListModels = vi.hoisted(() => vi.fn());
const MockOpenAI = vi.hoisted(() =>
  vi.fn(function (this: Record<string, unknown>, _config: Record<string, unknown>) {
    this.chat = {
      completions: {
        create: mockCreate,
      },
    };
    this.models = {
      list: mockListModels,
    };
    return this;
  })
);

vi.mock("openai", () => ({
  default: MockOpenAI,
}));

// Import after mock
import { OpenAIAdapter } from "../openai.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeChatCompletion(opts: {
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  finish_reason?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
} = {}) {
  const content = "content" in opts ? opts.content : "Hello";
  return {
    id: "chatcmpl-1",
    object: "chat.completion" as const,
    created: 1234567890,
    model: "gpt-5",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant" as const,
          content: content,
          tool_calls: opts.tool_calls,
        },
        finish_reason: opts.finish_reason ?? "stop",
      },
    ],
    usage: {
      prompt_tokens: opts.prompt_tokens ?? 10,
      completion_tokens: opts.completion_tokens ?? 5,
      total_tokens: (opts.prompt_tokens ?? 10) + (opts.completion_tokens ?? 5),
    },
  };
}

function makeToolCallCompletion() {
  return makeChatCompletion({
    content: null,
    tool_calls: [
      {
        id: "call_abc",
        type: "function" as const,
        function: { name: "get_weather", arguments: '{"city":"NYC"}' },
      },
    ],
    finish_reason: "tool_calls",
  });
}

/** Build an async iterable from an array of SSE-style chunks */
async function* makeChunkStream(
  chunks: Array<Record<string, unknown>>
): AsyncIterable<Record<string, unknown>> {
  for (const c of chunks) yield c;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("OpenAIAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Construction ─────────────────────────────────────────────────────────

  describe("constructor", () => {
    it("should pass apiKey and baseURL to OpenAI client", () => {
      new OpenAIAdapter("sk-123", "https://api.openai.com/v1");
      expect(MockOpenAI).toHaveBeenCalledWith({
        apiKey: "sk-123",
        baseURL: "https://api.openai.com/v1",
        defaultHeaders: undefined,
      });
    });

    it("should handle omitted parameters", () => {
      new OpenAIAdapter();
      expect(MockOpenAI).toHaveBeenCalledWith({
        apiKey: undefined,
        baseURL: undefined,
        defaultHeaders: undefined,
      });
    });

    it("should pass apiKey only", () => {
      new OpenAIAdapter("sk-only");
      expect(MockOpenAI).toHaveBeenCalledWith({
        apiKey: "sk-only",
        baseURL: undefined,
        defaultHeaders: undefined,
      });
    });

    it("should pass headers to OpenAI client", () => {
      const headers = { "X-Test": "enabled" };
      new OpenAIAdapter("key", "https://api.openai.com/v1", headers);
      expect(MockOpenAI).toHaveBeenCalledWith({
        apiKey: "key",
        baseURL: "https://api.openai.com/v1",
        defaultHeaders: headers,
      });
    });

    it("should append /v1 for OpenAI-compatible gateways without a version path", () => {
      new OpenAIAdapter("sk-123", "https://gateway.example.com");
      expect(MockOpenAI).toHaveBeenCalledWith({
        apiKey: "sk-123",
        baseURL: "https://gateway.example.com/v1",
        defaultHeaders: undefined,
      });
    });
  });

  // ── complete() ───────────────────────────────────────────────────────────

  describe("complete", () => {
    it("should return a text response", async () => {
      mockCreate.mockResolvedValueOnce(makeChatCompletion({ content: "Hi there" }));

      const adapter = new OpenAIAdapter("k");
      const req: CompletionRequest = {
        model: "gpt-5",
        messages: [{ role: "user", content: "Hello" }],
      };
      const res = await adapter.complete(req);

      expect(res.message.content).toBe("Hi there");
      expect(res.stop_reason).toBe("end_turn");
      expect(res.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    });

    it("should return tool_calls with tool_use stop_reason", async () => {
      mockCreate.mockResolvedValueOnce(makeToolCallCompletion());

      const adapter = new OpenAIAdapter("k");
      const res = await adapter.complete({
        model: "gpt-5",
        messages: [{ role: "user", content: "weather?" }],
      });

      expect(res.stop_reason).toBe("tool_use");
      const parts = res.message.content as ContentPart[];
      expect(parts).toHaveLength(1);
      expect(parts[0]).toEqual({
        type: "tool_call",
        id: "call_abc",
        name: "get_weather",
        arguments: '{"city":"NYC"}',
      });
    });

    it("should handle mixed text and tool_calls response", async () => {
      mockCreate.mockResolvedValueOnce(
        makeChatCompletion({
          content: "Let me check...",
          tool_calls: [
            {
              id: "c1",
              type: "function" as const,
              function: { name: "search", arguments: "{}" },
            },
          ],
          finish_reason: "tool_calls",
        })
      );

      const adapter = new OpenAIAdapter("k");
      const res = await adapter.complete({
        model: "gpt-5",
        messages: [{ role: "user", content: "search" }],
      });

      const parts = res.message.content as ContentPart[];
      expect(parts).toHaveLength(2);
      expect(parts[0]).toEqual({ type: "text", text: "Let me check..." });
      expect(parts[1].type).toBe("tool_call");
    });

    it("should pass temperature", async () => {
      mockCreate.mockResolvedValueOnce(makeChatCompletion());

      const adapter = new OpenAIAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        temperature: 0.7,
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ temperature: 0.7 })
      );
    });

    it("should omit temperature when not set", async () => {
      mockCreate.mockResolvedValueOnce(makeChatCompletion());

      const adapter = new OpenAIAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      });

      const call = mockCreate.mock.calls[0][0] as Record<string, unknown>;
      expect(call.temperature).toBeUndefined();
    });

    it("should pass max_tokens", async () => {
      mockCreate.mockResolvedValueOnce(makeChatCompletion());

      const adapter = new OpenAIAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        max_tokens: 200,
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ max_tokens: 200 })
      );
    });

    it("should omit max_tokens when not set", async () => {
      mockCreate.mockResolvedValueOnce(makeChatCompletion());

      const adapter = new OpenAIAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      });

      const call = mockCreate.mock.calls[0][0] as Record<string, unknown>;
      expect(call.max_tokens).toBeUndefined();
    });

    it("should propagate API errors", async () => {
      mockCreate.mockRejectedValueOnce(new Error("401 Unauthorized"));

      const adapter = new OpenAIAdapter("k");
      await expect(
        adapter.complete({ model: "m", messages: [{ role: "user", content: "x" }] })
      ).rejects.toThrow("401 Unauthorized");
    });

    it("should skip non-function tool_calls in response", async () => {
      mockCreate.mockResolvedValueOnce({
        id: "chatcmpl-skip",
        object: "chat.completion",
        created: 1,
        model: "gpt-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "t1", type: "retrieval", retrieval: {} },
              ],
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      const adapter = new OpenAIAdapter("k");
      const res = await adapter.complete({
        model: "gpt-5",
        messages: [{ role: "user", content: "x" }],
      });

      // Non-function tool_calls are skipped; content should be empty
      const parts = res.message.content as ContentPart[];
      expect(parts).toHaveLength(0);
    });

    it("should handle response with no usage", async () => {
      mockCreate.mockResolvedValueOnce({
        id: "chatcmpl-no-usage",
        object: "chat.completion",
        created: 1,
        model: "gpt-5",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "OK" },
            finish_reason: "stop",
          },
        ],
        usage: undefined,
      });

      const adapter = new OpenAIAdapter("k");
      const res = await adapter.complete({
        model: "gpt-5",
        messages: [{ role: "user", content: "x" }],
      });

      expect(res.usage).toBeUndefined();
    });
  });

  // ── stream() ─────────────────────────────────────────────────────────────

  describe("stream", () => {
    it("should yield text deltas from delta.content", async () => {
      mockCreate.mockResolvedValue(
        makeChunkStream([
          { id: "chunk1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "Hi" } }] },
          { id: "chunk2", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: " there" } }] },
          { id: "chunk3", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
        ])
      );

      const adapter = new OpenAIAdapter("k");
      const events: StreamEvent[] = [];
      for await (const e of adapter.stream({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      })) {
        events.push(e);
      }

      expect(events).toContainEqual({ type: "text", text: "Hi" });
      expect(events).toContainEqual({ type: "text", text: " there" });
    });

    it("should yield reasoning_content as thinking", async () => {
      mockCreate.mockResolvedValue(
        makeChunkStream([
          {
            id: "c1", object: "chat.completion.chunk", created: 1, model: "m",
            choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "Let me think..." } }],
          },
          {
            id: "c2", object: "chat.completion.chunk", created: 1, model: "m",
            choices: [{ index: 0, delta: { content: "Answer" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          },
        ])
      );

      const adapter = new OpenAIAdapter("k");
      const events: StreamEvent[] = [];
      for await (const e of adapter.stream({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      })) {
        events.push(e);
      }

      expect(events).toContainEqual({ type: "thinking", text: "Let me think..." });
    });

    it("should skip empty string reasoning_content", async () => {
      mockCreate.mockResolvedValue(
        makeChunkStream([
          {
            id: "c1", object: "chat.completion.chunk", created: 1, model: "m",
            choices: [{ index: 0, delta: { reasoning_content: "" } }],
          },
          {
            id: "c2", object: "chat.completion.chunk", created: 1, model: "m",
            choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        ])
      );

      const adapter = new OpenAIAdapter("k");
      const events: StreamEvent[] = [];
      for await (const e of adapter.stream({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      })) {
        events.push(e);
      }

      // Empty reasoning_content should not yield a thinking event
      expect(events.filter((e) => e.type === "thinking")).toHaveLength(0);
    });

    it("should not emit thinking when reasoning_content is not a string", async () => {
      mockCreate.mockResolvedValue(
        makeChunkStream([
          {
            id: "c1", object: "chat.completion.chunk", created: 1, model: "m",
            choices: [{ index: 0, delta: { reasoning_content: 123 } }],
          },
          {
            id: "c2", object: "chat.completion.chunk", created: 1, model: "m",
            choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        ])
      );

      const adapter = new OpenAIAdapter("k");
      const events: StreamEvent[] = [];
      for await (const e of adapter.stream({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      })) {
        events.push(e);
      }

      expect(events.filter((e) => e.type === "thinking")).toHaveLength(0);
    });

    it("should accumulate tool_call arguments from stream chunks", async () => {
      mockCreate.mockResolvedValue(
        makeChunkStream([
          {
            id: "c1", object: "chat.completion.chunk", created: 1, model: "m",
            choices: [{
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_x",
                    type: "function" as const,
                    function: { name: "search", arguments: '{"q":' },
                  },
                ],
              },
            }],
          },
          {
            id: "c2", object: "chat.completion.chunk", created: 1, model: "m",
            choices: [{
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: '"query"' },
                  },
                ],
              },
            }],
          },
          {
            id: "c3", object: "chat.completion.chunk", created: 1, model: "m",
            choices: [{
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: "}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          },
        ])
      );

      const adapter = new OpenAIAdapter("k");
      const events: StreamEvent[] = [];
      for await (const e of adapter.stream({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      })) {
        events.push(e);
      }

      const tc = events.find((e) => e.type === "tool_call");
      expect(tc).toBeDefined();
      expect(tc).toMatchObject({
        type: "tool_call",
        id: "call_x",
        name: "search",
        arguments: '{"q":"query"}',
      });
    });

    it("should handle tool_calls without id in delta (follow-up chunk)", async () => {
      mockCreate.mockResolvedValue(
        makeChunkStream([
          {
            id: "c1", object: "chat.completion.chunk", created: 1, model: "m",
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "f1", arguments: "" } }],
              },
            }],
          },
          {
            id: "c2", object: "chat.completion.chunk", created: 1, model: "m",
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }],
              },
              finish_reason: "tool_calls",
            }],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          },
        ])
      );

      const adapter = new OpenAIAdapter("k");
      const events: StreamEvent[] = [];
      for await (const e of adapter.stream({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      })) {
        events.push(e);
      }

      const tc = events.find((e) => e.type === "tool_call");
      expect(tc).toMatchObject({ arguments: '{"a":1}' });
    });

    it("should yield done with end_turn stop_reason", async () => {
      mockCreate.mockResolvedValue(
        makeChunkStream([
          {
            id: "c1", object: "chat.completion.chunk", created: 1, model: "m",
            choices: [{ index: 0, delta: { content: "Done" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        ])
      );

      const adapter = new OpenAIAdapter("k");
      const events: StreamEvent[] = [];
      for await (const e of adapter.stream({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      })) {
        events.push(e);
      }

      const done = events.find((e) => e.type === "done");
      expect(done!.stop_reason).toBe("end_turn");
    });

    it("should yield done with tool_use when finish_reason is tool_calls", async () => {
      mockCreate.mockResolvedValue(
        makeChunkStream([
          {
            id: "c1", object: "chat.completion.chunk", created: 1, model: "m",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        ])
      );

      const adapter = new OpenAIAdapter("k");
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

    it("should extract reasoning_tokens from usage chunk", async () => {
      mockCreate.mockResolvedValue(
        makeChunkStream([
          {
            id: "c1", object: "chat.completion.chunk", created: 1, model: "m",
            choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 5,
              completion_tokens: 10,
              total_tokens: 15,
              completion_tokens_details: { reasoning_tokens: 3 },
            },
          },
        ])
      );

      const adapter = new OpenAIAdapter("k");
      const events: StreamEvent[] = [];
      for await (const e of adapter.stream({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      })) {
        events.push(e);
      }

      const done = events.find((e) => e.type === "done");
      expect(done!.usage?.reasoning_tokens).toBe(3);
    });

    it("should handle usage chunk without details", async () => {
      mockCreate.mockResolvedValue(
        makeChunkStream([
          {
            id: "c1", object: "chat.completion.chunk", created: 1, model: "m",
            choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          },
        ])
      );

      const adapter = new OpenAIAdapter("k");
      const events: StreamEvent[] = [];
      for await (const e of adapter.stream({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      })) {
        events.push(e);
      }

      const done = events.find((e) => e.type === "done");
      expect(done!.usage?.reasoning_tokens).toBeUndefined();
    });

    it("should propagate stream errors", async () => {
      async function* errorStream() {
        yield { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "a" } }] };
        throw new Error("Stream broken");
      }
      mockCreate.mockResolvedValue(errorStream());

      const adapter = new OpenAIAdapter("k");
      const iter = adapter.stream({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      });

      await expect(async () => {
        for await (const _ of iter) {
          // consume
        }
      }).rejects.toThrow("Stream broken");
    });

    it("should handle stream with no usage info", async () => {
      mockCreate.mockResolvedValue(
        makeChunkStream([
          {
            id: "c1", object: "chat.completion.chunk", created: 1, model: "m",
            choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: "stop" }],
          },
        ])
      );

      const adapter = new OpenAIAdapter("k");
      const events: StreamEvent[] = [];
      for await (const e of adapter.stream({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      })) {
        events.push(e);
      }

      const done = events.find((e) => e.type === "done");
      expect(done!.usage).toBeUndefined();
    });

    it("should use stream_options with include_usage", async () => {
      mockCreate.mockResolvedValue(
        makeChunkStream([
          {
            id: "c1", object: "chat.completion.chunk", created: 1, model: "m",
            choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        ])
      );

      const adapter = new OpenAIAdapter("k");
      for await (const _ of adapter.stream({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      })) {
        // consume
      }

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          stream: true,
          stream_options: { include_usage: true },
        })
      );
    });
  });

  // ── listModels() ─────────────────────────────────────────────────────────

  describe("listModels", () => {
    it("should map model list from OpenAI API", async () => {
      mockListModels.mockResolvedValueOnce({
        data: [
          { id: "gpt-5", created: 1700000000 },
          { id: "gpt-5-mini", created: 1700000000 },
        ],
      });

      const adapter = new OpenAIAdapter("k");
      const models = await adapter.listModels();

      expect(models).toHaveLength(2);
      expect(models[0]).toEqual({ id: "gpt-5", created: 1700000000 });
    });

    it("should handle empty model list", async () => {
      mockListModels.mockResolvedValueOnce({ data: [] });

      const adapter = new OpenAIAdapter("k");
      const models = await adapter.listModels();
      expect(models).toHaveLength(0);
    });
  });

  // ── toOpenAIMessages (coverage via complete) ──────────────────────────────

  describe("message conversion (via complete)", () => {
    it("should put system prompt as first message", async () => {
      mockCreate.mockResolvedValueOnce(makeChatCompletion());

      const adapter = new OpenAIAdapter("k");
      await adapter.complete({
        model: "m",
        system: "You are a bot",
        messages: [{ role: "user", content: "Hi" }],
      });

      const call = mockCreate.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> };
      expect(call.messages[0]).toEqual({ role: "system", content: "You are a bot" });
    });

    it("should keep existing system messages in messages array", async () => {
      mockCreate.mockResolvedValueOnce(makeChatCompletion());

      const adapter = new OpenAIAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [
          { role: "system", content: "Rule 1" },
          { role: "user", content: "Hi" },
        ],
      });

      const call = mockCreate.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> };
      expect(call.messages[0]).toEqual({ role: "system", content: "Rule 1" });
    });

    it("should convert system message with array content to string", async () => {
      mockCreate.mockResolvedValueOnce(makeChatCompletion());

      const adapter = new OpenAIAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [
          {
            role: "system",
            content: [{ type: "text", text: "system text" }],
          },
          { role: "user", content: "Hi" },
        ],
      });

      const call = mockCreate.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> };
      expect(call.messages[0]).toEqual({ role: "system", content: "" });
    });

    it("should convert tool messages", async () => {
      mockCreate.mockResolvedValueOnce(makeChatCompletion());

      const adapter = new OpenAIAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [
          { role: "user", content: "search" },
          { role: "tool", tool_call_id: "t1", content: "result" },
        ],
      });

      const call = mockCreate.mock.calls[0][0] as { messages: Array<Record<string, unknown>> };
      const toolMsg = call.messages[1];
      expect(toolMsg).toEqual({
        role: "tool",
        tool_call_id: "t1",
        content: "result",
      });
    });

    it("should convert tool message with array content to string", async () => {
      mockCreate.mockResolvedValueOnce(makeChatCompletion());

      const adapter = new OpenAIAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [
          {
            role: "tool",
            tool_call_id: "t1",
            content: [{ type: "text", text: "multi" }],
          },
        ],
      });

      const call = mockCreate.mock.calls[0][0] as { messages: Array<Record<string, unknown>> };
      expect(call.messages[0].content).toBe("");
    });

    it("should preserve image_url parts for user messages", async () => {
      mockCreate.mockResolvedValueOnce(makeChatCompletion());

      const adapter = new OpenAIAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
              { type: "text", text: "describe this image" },
            ],
          },
        ],
      });

      const call = mockCreate.mock.calls[0][0] as { messages: Array<Record<string, unknown>> };
      expect(call.messages[0].content).toEqual([
        { type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
        { type: "text", text: "describe this image" },
      ]);
    });

    it("should convert assistant message with tool calls", async () => {
      mockCreate.mockResolvedValueOnce(makeChatCompletion());

      const adapter = new OpenAIAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "Using tool" },
              {
                type: "tool_call",
                id: "tc1",
                name: "search",
                arguments: '{"q":"test"}',
              },
            ],
          },
          { role: "user", content: "ok" },
        ],
      });

      const call = mockCreate.mock.calls[0][0] as { messages: Array<Record<string, unknown>> };
      const asst = call.messages[0] as Record<string, unknown>;
      expect(asst.role).toBe("assistant");
      expect(asst.content).toHaveLength(1);
      expect((asst.tool_calls as Array<Record<string, unknown>>)[0]).toMatchObject({
        id: "tc1",
        type: "function",
        function: { name: "search", arguments: '{"q":"test"}' },
      });
    });

    it("should convert user message with array content", async () => {
      mockCreate.mockResolvedValueOnce(makeChatCompletion());

      const adapter = new OpenAIAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Part 1" },
              { type: "text", text: "Part 2" },
            ],
          },
        ],
      });

      const call = mockCreate.mock.calls[0][0] as { messages: Array<Record<string, unknown>> };
      expect(call.messages[0].role).toBe("user");
      const content = call.messages[0].content as Array<Record<string, unknown>>;
      expect(content).toHaveLength(2);
      expect(content[0].text).toBe("Part 1");
    });
  });

  // ── toOpenAITools (coverage via complete) ────────────────────────────────

  describe("tool conversion (via complete)", () => {
    it("should convert tools to OpenAI format", async () => {
      mockCreate.mockResolvedValueOnce(makeChatCompletion());

      const adapter = new OpenAIAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        tools: [
          {
            name: "search",
            description: "Search the web",
            parameters: {
              type: "object" as const,
              properties: {
                query: { type: "string", description: "Query" },
              },
              required: ["query"],
            },
          },
        ],
      });

      const call = mockCreate.mock.calls[0][0] as { tools: Array<Record<string, unknown>> };
      expect(call.tools).toHaveLength(1);
      expect(call.tools[0]).toEqual({
        type: "function",
        function: {
          name: "search",
          description: "Search the web",
          parameters: {
            type: "object",
            properties: { query: { type: "string", description: "Query" } },
            required: ["query"],
          },
        },
      });
    });

    it("should return undefined for empty tools", async () => {
      mockCreate.mockResolvedValueOnce(makeChatCompletion());

      const adapter = new OpenAIAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        tools: [],
      });

      const call = mockCreate.mock.calls[0][0] as Record<string, unknown>;
      expect(call.tools).toBeUndefined();
    });
  });

  // ── stream tool_call edge cases ─────────────────────────────────────────

  describe("stream tool_call edge cases", () => {
    it("should handle tool_calls with null function names and arguments", async () => {
      mockCreate.mockResolvedValue(
        makeChunkStream([
          {
            id: "c1", object: "chat.completion.chunk", created: 1, model: "m",
            choices: [{
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: null,
                    type: "function" as const,
                    function: { name: null, arguments: null },
                  },
                ],
              },
            }],
          },
          {
            id: "c2", object: "chat.completion.chunk", created: 1, model: "m",
            choices: [{
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: "{}" },
                  },
                ],
                finish_reason: "tool_calls",
              },
            }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        ])
      );

      const adapter = new OpenAIAdapter("k");
      const events: StreamEvent[] = [];
      for await (const e of adapter.stream({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      })) {
        events.push(e);
      }

      const tc = events.find((e) => e.type === "tool_call");
      expect(tc).toBeDefined();
      // id and name default to "" when null
      expect(tc!.id).toBe("");
      expect(tc!.name).toBe("");
      expect(tc!.arguments).toBe("{}");
    });
  });
});
