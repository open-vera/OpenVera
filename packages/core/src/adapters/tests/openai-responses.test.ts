/**
 * Unit tests for OpenAIResponsesAdapter (OpenAI /v1/responses protocol).
 * Covers: construction, complete(), stream(), listModels(), and input/tool mappings.
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
    this.responses = {
      create: mockCreate,
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
import { OpenAIResponsesAdapter } from "../openai-responses.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeResponse(opts: {
  output?: Array<Record<string, unknown>>;
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  incomplete_reason?: string;
  usage?: null;
} = {}) {
  return {
    id: "resp_1",
    object: "response" as const,
    created_at: 1234567890,
    model: "gpt-5",
    status: opts.incomplete_reason ? "incomplete" : "completed",
    output: opts.output ?? [
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Hello", annotations: [] }],
      },
    ],
    incomplete_details: opts.incomplete_reason ? { reason: opts.incomplete_reason } : null,
    usage:
      opts.usage === null
        ? undefined
        : {
            input_tokens: opts.input_tokens ?? 10,
            output_tokens: opts.output_tokens ?? 5,
            total_tokens: (opts.input_tokens ?? 10) + (opts.output_tokens ?? 5),
            ...(opts.reasoning_tokens != null
              ? { output_tokens_details: { reasoning_tokens: opts.reasoning_tokens } }
              : {}),
          },
  };
}

function makeFunctionCallItem(overrides: Record<string, unknown> = {}) {
  return {
    type: "function_call",
    id: "fc_1",
    call_id: "call_abc",
    name: "get_weather",
    arguments: '{"city":"NYC"}',
    status: "completed",
    ...overrides,
  };
}

/** Build an async iterable from an array of Responses SSE events */
async function* makeEventStream(
  events: Array<Record<string, unknown>>
): AsyncIterable<Record<string, unknown>> {
  for (const e of events) yield e;
}

async function collect(adapter: OpenAIResponsesAdapter, req: CompletionRequest): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of adapter.stream(req)) events.push(e);
  return events;
}

const USER_REQ: CompletionRequest = {
  model: "gpt-5",
  messages: [{ role: "user", content: "Hello" }],
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("OpenAIResponsesAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("constructor", () => {
    it("should pass apiKey, baseURL and headers to OpenAI client", () => {
      const headers = { "X-Test": "enabled" };
      new OpenAIResponsesAdapter("sk-123", "https://api.openai.com/v1", headers);
      expect(MockOpenAI).toHaveBeenCalledWith({
        apiKey: "sk-123",
        baseURL: "https://api.openai.com/v1",
        defaultHeaders: headers,
      });
    });

    it("should handle omitted parameters", () => {
      new OpenAIResponsesAdapter();
      expect(MockOpenAI).toHaveBeenCalledWith({
        apiKey: undefined,
        baseURL: undefined,
        defaultHeaders: undefined,
      });
    });
  });

  describe("complete", () => {
    it("should return a text response", async () => {
      mockCreate.mockResolvedValueOnce(makeResponse());

      const adapter = new OpenAIResponsesAdapter("k");
      const res = await adapter.complete(USER_REQ);

      expect(res.message.content).toBe("Hello");
      expect(res.stop_reason).toBe("end_turn");
      expect(res.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    });

    it("should return tool_calls with tool_use stop_reason", async () => {
      mockCreate.mockResolvedValueOnce(
        makeResponse({ output: [makeFunctionCallItem()] })
      );

      const adapter = new OpenAIResponsesAdapter("k");
      const res = await adapter.complete(USER_REQ);

      expect(res.stop_reason).toBe("tool_use");
      const parts = res.message.content as ContentPart[];
      expect(parts).toEqual([
        {
          type: "tool_call",
          id: "call_abc",
          name: "get_weather",
          arguments: '{"city":"NYC"}',
        },
      ]);
    });

    it("should handle mixed message and function_call output", async () => {
      mockCreate.mockResolvedValueOnce(
        makeResponse({
          output: [
            {
              type: "message",
              id: "msg_1",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "Let me check...", annotations: [] }],
            },
            makeFunctionCallItem(),
          ],
        })
      );

      const adapter = new OpenAIResponsesAdapter("k");
      const res = await adapter.complete(USER_REQ);

      const parts = res.message.content as ContentPart[];
      expect(parts).toHaveLength(2);
      expect(parts[0]).toEqual({ type: "text", text: "Let me check..." });
      expect(parts[1].type).toBe("tool_call");
    });

    it("should skip reasoning output items", async () => {
      mockCreate.mockResolvedValueOnce(
        makeResponse({
          output: [
            { type: "reasoning", id: "rs_1", summary: [] },
            {
              type: "message",
              id: "msg_1",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "OK", annotations: [] }],
            },
          ],
        })
      );

      const adapter = new OpenAIResponsesAdapter("k");
      const res = await adapter.complete(USER_REQ);
      expect(res.message.content).toBe("OK");
    });

    it("should map max_output_tokens truncation to max_tokens stop_reason", async () => {
      mockCreate.mockResolvedValueOnce(
        makeResponse({ incomplete_reason: "max_output_tokens" })
      );

      const adapter = new OpenAIResponsesAdapter("k");
      const res = await adapter.complete(USER_REQ);
      expect(res.stop_reason).toBe("max_tokens");
    });

    it("should extract reasoning_tokens from usage", async () => {
      mockCreate.mockResolvedValueOnce(makeResponse({ reasoning_tokens: 7 }));

      const adapter = new OpenAIResponsesAdapter("k");
      const res = await adapter.complete(USER_REQ);
      expect(res.usage?.reasoning_tokens).toBe(7);
    });

    it("should handle response with no usage", async () => {
      mockCreate.mockResolvedValueOnce(makeResponse({ usage: null }));

      const adapter = new OpenAIResponsesAdapter("k");
      const res = await adapter.complete(USER_REQ);
      expect(res.usage).toBeUndefined();
    });

    it("should send instructions, max_output_tokens, temperature and store:false", async () => {
      mockCreate.mockResolvedValueOnce(makeResponse());

      const adapter = new OpenAIResponsesAdapter("k");
      await adapter.complete({
        ...USER_REQ,
        system: "You are a bot",
        max_tokens: 200,
        temperature: 0.7,
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          instructions: "You are a bot",
          max_output_tokens: 200,
          temperature: 0.7,
          store: false,
        })
      );
    });

    it("should omit instructions/max_output_tokens/temperature when not set", async () => {
      mockCreate.mockResolvedValueOnce(makeResponse());

      const adapter = new OpenAIResponsesAdapter("k");
      await adapter.complete(USER_REQ);

      const call = mockCreate.mock.calls[0][0] as Record<string, unknown>;
      expect(call.instructions).toBeUndefined();
      expect(call.max_output_tokens).toBeUndefined();
      expect(call.temperature).toBeUndefined();
    });

    it("should propagate API errors", async () => {
      mockCreate.mockRejectedValueOnce(new Error("401 Unauthorized"));

      const adapter = new OpenAIResponsesAdapter("k");
      await expect(adapter.complete(USER_REQ)).rejects.toThrow("401 Unauthorized");
    });
  });

  describe("stream", () => {
    it("should yield text deltas", async () => {
      mockCreate.mockResolvedValue(
        makeEventStream([
          { type: "response.output_text.delta", delta: "Hi" },
          { type: "response.output_text.delta", delta: " there" },
          { type: "response.completed", response: makeResponse() },
        ])
      );

      const adapter = new OpenAIResponsesAdapter("k");
      const events = await collect(adapter, USER_REQ);

      expect(events).toContainEqual({ type: "text", text: "Hi" });
      expect(events).toContainEqual({ type: "text", text: " there" });
    });

    it("should yield reasoning summary deltas as thinking", async () => {
      mockCreate.mockResolvedValue(
        makeEventStream([
          { type: "response.reasoning_summary_text.delta", delta: "Let me think..." },
          { type: "response.output_text.delta", delta: "Answer" },
          { type: "response.completed", response: makeResponse() },
        ])
      );

      const adapter = new OpenAIResponsesAdapter("k");
      const events = await collect(adapter, USER_REQ);

      expect(events).toContainEqual({ type: "thinking", text: "Let me think..." });
    });

    it("should yield complete tool_call from output_item.done", async () => {
      mockCreate.mockResolvedValue(
        makeEventStream([
          { type: "response.output_item.done", item: makeFunctionCallItem() },
          {
            type: "response.completed",
            response: makeResponse({ output: [makeFunctionCallItem()] }),
          },
        ])
      );

      const adapter = new OpenAIResponsesAdapter("k");
      const events = await collect(adapter, USER_REQ);

      expect(events).toContainEqual({
        type: "tool_call",
        id: "call_abc",
        name: "get_weather",
        arguments: '{"city":"NYC"}',
      });
      const done = events.find((e) => e.type === "done");
      expect(done!.stop_reason).toBe("tool_use");
    });

    it("should ignore non-function output_item.done items", async () => {
      mockCreate.mockResolvedValue(
        makeEventStream([
          {
            type: "response.output_item.done",
            item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [] },
          },
          { type: "response.completed", response: makeResponse() },
        ])
      );

      const adapter = new OpenAIResponsesAdapter("k");
      const events = await collect(adapter, USER_REQ);
      expect(events.filter((e) => e.type === "tool_call")).toHaveLength(0);
    });

    it("should yield done with usage and reasoning_tokens from response.completed", async () => {
      mockCreate.mockResolvedValue(
        makeEventStream([
          { type: "response.output_text.delta", delta: "OK" },
          {
            type: "response.completed",
            response: makeResponse({ input_tokens: 5, output_tokens: 10, reasoning_tokens: 3 }),
          },
        ])
      );

      const adapter = new OpenAIResponsesAdapter("k");
      const events = await collect(adapter, USER_REQ);

      const done = events.find((e) => e.type === "done");
      expect(done!.stop_reason).toBe("end_turn");
      expect(done!.usage).toEqual({ input_tokens: 5, output_tokens: 10, reasoning_tokens: 3 });
    });

    it("should yield max_tokens stop_reason on incomplete response", async () => {
      mockCreate.mockResolvedValue(
        makeEventStream([
          { type: "response.output_text.delta", delta: "trunc" },
          {
            type: "response.incomplete",
            response: makeResponse({ incomplete_reason: "max_output_tokens" }),
          },
        ])
      );

      const adapter = new OpenAIResponsesAdapter("k");
      const events = await collect(adapter, USER_REQ);

      const done = events.find((e) => e.type === "done");
      expect(done!.stop_reason).toBe("max_tokens");
    });

    it("should handle stream without usage", async () => {
      mockCreate.mockResolvedValue(
        makeEventStream([
          { type: "response.output_text.delta", delta: "Hi" },
        ])
      );

      const adapter = new OpenAIResponsesAdapter("k");
      const events = await collect(adapter, USER_REQ);

      const done = events.find((e) => e.type === "done");
      expect(done!.usage).toBeUndefined();
    });

    it("should throw on response.failed", async () => {
      mockCreate.mockResolvedValue(
        makeEventStream([
          {
            type: "response.failed",
            response: { ...makeResponse(), error: { code: "server_error", message: "boom" } },
          },
        ])
      );

      const adapter = new OpenAIResponsesAdapter("k");
      await expect(collect(adapter, USER_REQ)).rejects.toThrow("boom");
    });

    it("should throw on error event", async () => {
      mockCreate.mockResolvedValue(
        makeEventStream([
          { type: "error", code: "rate_limit", message: "too fast", param: null },
        ])
      );

      const adapter = new OpenAIResponsesAdapter("k");
      await expect(collect(adapter, USER_REQ)).rejects.toThrow("too fast");
    });

    it("should request stream with store:false", async () => {
      mockCreate.mockResolvedValue(
        makeEventStream([{ type: "response.completed", response: makeResponse() }])
      );

      const adapter = new OpenAIResponsesAdapter("k");
      await collect(adapter, USER_REQ);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ stream: true, store: false })
      );
    });
  });

  describe("listModels", () => {
    it("should map model list from OpenAI API", async () => {
      mockListModels.mockResolvedValueOnce({
        data: [
          { id: "gpt-5", created: 1700000000 },
          { id: "gpt-5-mini", created: 1700000000 },
        ],
      });

      const adapter = new OpenAIResponsesAdapter("k");
      const models = await adapter.listModels();

      expect(models).toEqual([
        { id: "gpt-5", created: 1700000000 },
        { id: "gpt-5-mini", created: 1700000000 },
      ]);
    });
  });

  describe("input conversion (via complete)", () => {
    it("should convert string messages to role items", async () => {
      mockCreate.mockResolvedValueOnce(makeResponse());

      const adapter = new OpenAIResponsesAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [
          { role: "system", content: "Rule 1" },
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello" },
        ],
      });

      const call = mockCreate.mock.calls[0][0] as { input: Array<Record<string, unknown>> };
      expect(call.input).toEqual([
        { role: "system", content: "Rule 1" },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
      ]);
    });

    it("should convert tool messages to function_call_output items", async () => {
      mockCreate.mockResolvedValueOnce(makeResponse());

      const adapter = new OpenAIResponsesAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [
          { role: "user", content: "search" },
          { role: "tool", tool_call_id: "call_1", content: "result" },
        ],
      });

      const call = mockCreate.mock.calls[0][0] as { input: Array<Record<string, unknown>> };
      expect(call.input[1]).toEqual({
        type: "function_call_output",
        call_id: "call_1",
        output: "result",
      });
    });

    it("should convert assistant tool_call parts to function_call items", async () => {
      mockCreate.mockResolvedValueOnce(makeResponse());

      const adapter = new OpenAIResponsesAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "Using tool" },
              { type: "tool_call", id: "call_1", name: "search", arguments: '{"q":"test"}' },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "found" },
        ],
      });

      const call = mockCreate.mock.calls[0][0] as { input: Array<Record<string, unknown>> };
      expect(call.input[0]).toEqual({ role: "assistant", content: "Using tool" });
      expect(call.input[1]).toEqual({
        type: "function_call",
        call_id: "call_1",
        name: "search",
        arguments: '{"q":"test"}',
      });
    });

    it("should omit empty assistant text when only tool calls present", async () => {
      mockCreate.mockResolvedValueOnce(makeResponse());

      const adapter = new OpenAIResponsesAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [
          {
            role: "assistant",
            content: [
              { type: "tool_call", id: "call_1", name: "search", arguments: "{}" },
            ],
          },
        ],
      });

      const call = mockCreate.mock.calls[0][0] as { input: Array<Record<string, unknown>> };
      expect(call.input).toHaveLength(1);
      expect(call.input[0].type).toBe("function_call");
    });

    it("should convert user image parts to input_image", async () => {
      mockCreate.mockResolvedValueOnce(makeResponse());

      const adapter = new OpenAIResponsesAdapter("k");
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

      const call = mockCreate.mock.calls[0][0] as { input: Array<Record<string, unknown>> };
      expect(call.input[0]).toEqual({
        role: "user",
        content: [
          { type: "input_image", image_url: "data:image/png;base64,abc123", detail: "auto" },
          { type: "input_text", text: "describe this image" },
        ],
      });
    });
  });

  describe("tool conversion (via complete)", () => {
    it("should convert tools to flat Responses function format", async () => {
      mockCreate.mockResolvedValueOnce(makeResponse());

      const adapter = new OpenAIResponsesAdapter("k");
      await adapter.complete({
        ...USER_REQ,
        tools: [
          {
            name: "search",
            description: "Search the web",
            parameters: {
              type: "object" as const,
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
        ],
      });

      const call = mockCreate.mock.calls[0][0] as { tools: Array<Record<string, unknown>> };
      expect(call.tools).toEqual([
        {
          type: "function",
          name: "search",
          description: "Search the web",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
          strict: false,
        },
      ]);
    });

    it("should omit tools when empty", async () => {
      mockCreate.mockResolvedValueOnce(makeResponse());

      const adapter = new OpenAIResponsesAdapter("k");
      await adapter.complete({ ...USER_REQ, tools: [] });

      const call = mockCreate.mock.calls[0][0] as Record<string, unknown>;
      expect(call.tools).toBeUndefined();
    });
  });
});
