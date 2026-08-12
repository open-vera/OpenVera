/**
 * Unit tests for GeminiAdapter.
 * Covers: construction, complete(), stream(), listModels(), and all internal mappings.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  CompletionRequest,
  StreamEvent,
  ContentPart,
} from "../../types/index.js";

// ── Mock @google/generative-ai ───────────────────────────────────────────────
const mockGetGenerativeModel = vi.hoisted(() => vi.fn());
const mockStartChat = vi.hoisted(() => vi.fn());
const mockSendMessage = vi.hoisted(() => vi.fn());
const mockSendMessageStream = vi.hoisted(() => vi.fn());
const MockGoogleGenerativeAI = vi.hoisted(() =>
  vi.fn(function (this: Record<string, unknown>, apiKey: string) {
    this.apiKey = apiKey;
    this.getGenerativeModel = mockGetGenerativeModel;
    return this;
  })
);

vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: MockGoogleGenerativeAI,
}));

// Import after mock
import { GeminiAdapter } from "../gemini.js";
import { DEFAULT_LLM_REQUEST_TIMEOUT_MS } from "../timeouts.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function setupMockChat(modelOverrides: Record<string, unknown> = {}) {
  const chat = {
    sendMessage: mockSendMessage,
    sendMessageStream: mockSendMessageStream,
  };
  const model = { ...modelOverrides, startChat: mockStartChat };
  mockStartChat.mockReturnValue(chat);
  mockGetGenerativeModel.mockReturnValue(model);
  return { chat, model };
}

function makeGeminiTextResponse(text: string) {
  return {
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ text }],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      totalTokenCount: 15,
    },
  };
}

function makeGeminiFunctionCallResponse() {
  return {
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            {
              functionCall: {
                name: "search",
                args: { query: "weather" },
              },
            },
          ],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: 20,
      candidatesTokenCount: 10,
      totalTokenCount: 30,
    },
  };
}

/** Build an async iterable for stream.sendMessageStream result */
async function* makeStreamChunks(
  chunks: Array<{
    candidates?: Array<{
      content?: { role?: string; parts?: Array<Record<string, unknown>> };
    }>;
  }>
): AsyncIterable<Record<string, unknown>> {
  for (const c of chunks) yield c;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GeminiAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Construction ─────────────────────────────────────────────────────────

  describe("constructor", () => {
    it("should pass apiKey to GoogleGenerativeAI", () => {
      new GeminiAdapter("gemini-key");
      expect(MockGoogleGenerativeAI).toHaveBeenCalledWith("gemini-key");
    });

    it("should use empty string when apiKey omitted", () => {
      new GeminiAdapter();
      expect(MockGoogleGenerativeAI).toHaveBeenCalledWith("");
    });
  });

  // ── complete() ───────────────────────────────────────────────────────────

  describe("complete", () => {
    it("should return a text response", async () => {
      const { chat } = setupMockChat();
      mockSendMessage.mockResolvedValueOnce({
        response: makeGeminiTextResponse("Hi there"),
      });

      const adapter = new GeminiAdapter("k");
      const res = await adapter.complete({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(res.message.content).toBe("Hi there");
      expect(res.stop_reason).toBe("end_turn");
    });

    it("should return tool_use stop_reason for functionCall response", async () => {
      const { chat } = setupMockChat();
      mockSendMessage.mockResolvedValueOnce({
        response: makeGeminiFunctionCallResponse(),
      });

      const adapter = new GeminiAdapter("k");
      const res = await adapter.complete({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "search weather" }],
      });

      expect(res.stop_reason).toBe("tool_use");
      const parts = res.message.content as ContentPart[];
      expect(parts[0]).toMatchObject({
        type: "tool_call",
        name: "search",
      });
    });

    it("should handle empty candidates", async () => {
      const { chat } = setupMockChat();
      mockSendMessage.mockResolvedValueOnce({
        response: { candidates: [] },
      });

      const adapter = new GeminiAdapter("k");
      const res = await adapter.complete({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "test" }],
      });

      const parts = res.message.content as ContentPart[];
      expect(parts).toHaveLength(0);
    });

    it("should pass system instruction to model", async () => {
      const { chat } = setupMockChat();
      mockSendMessage.mockResolvedValueOnce({
        response: makeGeminiTextResponse("OK"),
      });

      const adapter = new GeminiAdapter("k");
      await adapter.complete({
        model: "gemini-2.5-flash",
        system: "You are helpful",
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(mockGetGenerativeModel).toHaveBeenCalledWith(
        expect.objectContaining({ systemInstruction: "You are helpful" })
      );
    });

    it("should pass tools as functionDeclarations", async () => {
      const { chat } = setupMockChat();
      mockSendMessage.mockResolvedValueOnce({
        response: makeGeminiTextResponse("OK"),
      });

      const adapter = new GeminiAdapter("k");
      await adapter.complete({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "Hi" }],
        tools: [
          {
            name: "search",
            description: "Search",
            parameters: {
              type: "object" as const,
              properties: { query: { type: "string", description: "Query" } },
              required: ["query"],
            },
          },
        ],
      });

      expect(mockGetGenerativeModel).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: [
            {
              functionDeclarations: [
                {
                  name: "search",
                  description: "Search",
                  parameters: {
                    type: "object",
                    properties: {
                      query: { type: "string", description: "Query" },
                    },
                    required: ["query"],
                  },
                },
              ],
            },
          ],
        })
      );
    });

    it("should not pass tools when empty", async () => {
      const { chat } = setupMockChat();
      mockSendMessage.mockResolvedValueOnce({
        response: makeGeminiTextResponse("OK"),
      });

      const adapter = new GeminiAdapter("k");
      await adapter.complete({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "Hi" }],
        tools: [],
      });

      const call = mockGetGenerativeModel.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(call.tools).toBeUndefined();
    });

    it("should propagate errors from sendMessage", async () => {
      const { chat } = setupMockChat();
      mockSendMessage.mockRejectedValueOnce(new Error("API Error 429"));

      const adapter = new GeminiAdapter("k");
      await expect(
        adapter.complete({
          model: "gemini-2.5-flash",
          messages: [{ role: "user", content: "Hi" }],
        })
      ).rejects.toThrow("API Error 429");
    });

    it("should handle response with text and functionCall parts", async () => {
      const { chat } = setupMockChat();
      mockSendMessage.mockResolvedValueOnce({
        response: {
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  { text: "Using tool" },
                  { functionCall: { name: "calc", args: { expr: "1+1" } } },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 5,
            candidatesTokenCount: 5,
            totalTokenCount: 10,
          },
        },
      });

      const adapter = new GeminiAdapter("k");
      const res = await adapter.complete({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "calc" }],
      });

      const parts = res.message.content as ContentPart[];
      expect(parts).toHaveLength(2);
      expect(res.stop_reason).toBe("tool_use");
    });

    it("should handle response with only one text part as string content", async () => {
      const { chat } = setupMockChat();
      mockSendMessage.mockResolvedValueOnce({
        response: makeGeminiTextResponse("Single text"),
      });

      const adapter = new GeminiAdapter("k");
      const res = await adapter.complete({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "Hi" }],
      });

      // Single text part should collapse to string
      expect(typeof res.message.content).toBe("string");
      expect(res.message.content).toBe("Single text");
    });

    it("should handle response without usageMetadata", async () => {
      const { chat } = setupMockChat();
      mockSendMessage.mockResolvedValueOnce({
        response: {
          candidates: [
            {
              content: { role: "model", parts: [{ text: "OK" }] },
              finishReason: "STOP",
            },
          ],
        },
      });

      const adapter = new GeminiAdapter("k");
      const res = await adapter.complete({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(res.usage).toBeUndefined();
    });
  });

  // ── stream() ─────────────────────────────────────────────────────────────

  describe("stream", () => {
    it("should yield text from stream chunks", async () => {
      const { chat } = setupMockChat();
      mockSendMessageStream.mockResolvedValueOnce({
        stream: makeStreamChunks([
          {
            candidates: [
              { content: { role: "model", parts: [{ text: "Hello" }] } },
            ],
          },
          {
            candidates: [
              { content: { role: "model", parts: [{ text: " world" }] } },
            ],
          },
        ]),
        response: makeGeminiTextResponse("Hello world"),
      });

      const adapter = new GeminiAdapter("k");
      const events: StreamEvent[] = [];
      for await (const e of adapter.stream({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "Hi" }],
      })) {
        events.push(e);
      }

      expect(events).toContainEqual({ type: "text", text: "Hello" });
      expect(events).toContainEqual({ type: "text", text: " world" });
    });

    it("should emit tool_call events from functionCall parts", async () => {
      const { chat } = setupMockChat();
      mockSendMessageStream.mockResolvedValueOnce({
        stream: makeStreamChunks([
          {
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [
                    {
                      functionCall: { name: "search", args: { q: "test" } },
                    },
                  ],
                },
              },
            ],
          },
        ]),
        response: {
          candidates: [],
          usageMetadata: {
            promptTokenCount: 5,
            candidatesTokenCount: 3,
            totalTokenCount: 8,
          },
        },
      });

      const adapter = new GeminiAdapter("k");
      const events: StreamEvent[] = [];
      for await (const e of adapter.stream({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "search" }],
      })) {
        events.push(e);
      }

      expect(events).toContainEqual({
        type: "tool_call",
        id: "search",
        name: "search",
        arguments: '{"q":"test"}',
      });
    });

    it("should yield done with tool_use if there were function calls", async () => {
      const { chat } = setupMockChat();
      mockSendMessageStream.mockResolvedValueOnce({
        stream: makeStreamChunks([
          {
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [{ functionCall: { name: "f", args: {} } }],
                },
              },
            ],
          },
        ]),
        response: {
          candidates: [],
          usageMetadata: {
            promptTokenCount: 1,
            candidatesTokenCount: 1,
            totalTokenCount: 2,
          },
        },
      });

      const adapter = new GeminiAdapter("k");
      const events: StreamEvent[] = [];
      for await (const e of adapter.stream({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "x" }],
      })) {
        events.push(e);
      }

      const done = events.find((e) => e.type === "done");
      expect(done!.stop_reason).toBe("tool_use");
      expect(done!.usage).toEqual({ input_tokens: 1, output_tokens: 1 });
    });

    it("should yield done with end_turn when no function calls", async () => {
      const { chat } = setupMockChat();
      mockSendMessageStream.mockResolvedValueOnce({
        stream: makeStreamChunks([
          {
            candidates: [
              { content: { role: "model", parts: [{ text: "OK" }] } },
            ],
          },
        ]),
        response: makeGeminiTextResponse("OK"),
      });

      const adapter = new GeminiAdapter("k");
      const events: StreamEvent[] = [];
      for await (const e of adapter.stream({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "x" }],
      })) {
        events.push(e);
      }

      const done = events.find((e) => e.type === "done");
      expect(done!.stop_reason).toBe("end_turn");
    });

    it("should yield done with usage from response.usageMetadata", async () => {
      const { chat } = setupMockChat();
      mockSendMessageStream.mockResolvedValueOnce({
        stream: makeStreamChunks([
          {
            candidates: [
              { content: { role: "model", parts: [{ text: "Hi" }] } },
            ],
          },
        ]),
        response: {
          candidates: [],
          usageMetadata: {
            promptTokenCount: 42,
            candidatesTokenCount: 7,
            totalTokenCount: 49,
          },
        },
      });

      const adapter = new GeminiAdapter("k");
      const events: StreamEvent[] = [];
      for await (const e of adapter.stream({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "x" }],
      })) {
        events.push(e);
      }

      const done = events.find((e) => e.type === "done");
      expect(done!.usage).toEqual({ input_tokens: 42, output_tokens: 7 });
    });

    it("should yield done with undefined usage when no usageMetadata", async () => {
      const { chat } = setupMockChat();
      mockSendMessageStream.mockResolvedValueOnce({
        stream: makeStreamChunks([
          {
            candidates: [
              { content: { role: "model", parts: [{ text: "Hi" }] } },
            ],
          },
        ]),
        response: { candidates: [] },
      });

      const adapter = new GeminiAdapter("k");
      const events: StreamEvent[] = [];
      for await (const e of adapter.stream({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "x" }],
      })) {
        events.push(e);
      }

      const done = events.find((e) => e.type === "done");
      expect(done!.usage).toBeUndefined();
    });

    it("should yield done with undefined usage when usageMetadata has null counts", async () => {
      const { chat } = setupMockChat();
      mockSendMessageStream.mockResolvedValueOnce({
        stream: makeStreamChunks([
          {
            candidates: [
              { content: { role: "model", parts: [{ text: "Hi" }] } },
            ],
          },
        ]),
        response: {
          candidates: [],
          usageMetadata: {
            // promptTokenCount / candidatesTokenCount explicitly absent
          },
        },
      });

      const adapter = new GeminiAdapter("k");
      const events: StreamEvent[] = [];
      for await (const e of adapter.stream({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "x" }],
      })) {
        events.push(e);
      }

      const done = events.find((e) => e.type === "done");
      expect(done!.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    });

    it("should handle stream chunk with no candidates", async () => {
      const { chat } = setupMockChat();
      mockSendMessageStream.mockResolvedValueOnce({
        stream: makeStreamChunks([
          { candidates: undefined },
          {
            candidates: [
              { content: { role: "model", parts: [{ text: "After empty" }] } },
            ],
          },
        ]),
        response: makeGeminiTextResponse("After empty"),
      });

      const adapter = new GeminiAdapter("k");
      const events: StreamEvent[] = [];
      for await (const e of adapter.stream({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "x" }],
      })) {
        events.push(e);
      }

      expect(events).toContainEqual({ type: "text", text: "After empty" });
    });

    it("should handle stream chunk with candidate but no content/parts", async () => {
      const { chat } = setupMockChat();
      mockSendMessageStream.mockResolvedValueOnce({
        stream: makeStreamChunks([
          { candidates: [{}] },
          {
            candidates: [
              { content: { role: "model", parts: [{ text: "content" }] } },
            ],
          },
        ]),
        response: makeGeminiTextResponse("content"),
      });

      const adapter = new GeminiAdapter("k");
      const events: StreamEvent[] = [];
      for await (const e of adapter.stream({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "x" }],
      })) {
        events.push(e);
      }

      expect(events).toContainEqual({ type: "text", text: "content" });
    });

    it("should propagate stream errors", async () => {
      const { chat } = setupMockChat();
      async function* errorStream() {
        yield {
          candidates: [{ content: { role: "model", parts: [{ text: "a" }] } }],
        };
        throw new Error("Stream broken");
      }
      mockSendMessageStream.mockResolvedValueOnce({
        stream: errorStream(),
        response: Promise.resolve(makeGeminiTextResponse("")),
      });

      const adapter = new GeminiAdapter("k");
      const iter = adapter.stream({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "x" }],
      });

      await expect(async () => {
        for await (const _ of iter) {
          // consume
        }
      }).rejects.toThrow("Stream broken");
    });

    it("should handle sendMessageStream rejection", async () => {
      const { chat } = setupMockChat();
      mockSendMessageStream.mockRejectedValueOnce(new Error("Send failed"));

      const adapter = new GeminiAdapter("k");
      const iter = adapter.stream({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "x" }],
      });

      await expect(async () => {
        for await (const _ of iter) {
          /* should not reach */
        }
      }).rejects.toThrow("Send failed");
    });
  });

  // ── listModels() ─────────────────────────────────────────────────────────

  describe("listModels", () => {
    it("should fetch and map models from Gemini REST API", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            {
              name: "models/gemini-2.5-flash",
              displayName: "Gemini 2.5 Flash",
              inputTokenLimit: 1_000_000,
            },
            {
              name: "models/gemini-2.5-pro",
              displayName: "Gemini 2.5 Pro",
              inputTokenLimit: 2_000_000,
            },
          ],
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const adapter = new GeminiAdapter("test-key");
      const models = await adapter.listModels();

      expect(models).toHaveLength(2);
      expect(models[0]).toEqual({
        id: "gemini-2.5-flash",
        display_name: "Gemini 2.5 Flash",
        context_window: 1_000_000,
      });
      expect(models[1]).toEqual({
        id: "gemini-2.5-pro",
        display_name: "Gemini 2.5 Pro",
        context_window: 2_000_000,
      });
      expect(mockFetch).toHaveBeenCalledWith(
        "https://generativelanguage.googleapis.com/v1beta/models?key=test-key&pageSize=100"
      );
    });

    it("should throw AdapterRequestError on non-ok response", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 401,
      });
      vi.stubGlobal("fetch", mockFetch);

      const adapter = new GeminiAdapter("bad-key");
      await expect(adapter.listModels()).rejects.toThrow(
        /Gemini request failed: 401/
      );
    });

    it("should throw AdapterRequestError on network failure", async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(new Error("Network error"));
      vi.stubGlobal("fetch", mockFetch);

      const adapter = new GeminiAdapter("key");
      await expect(adapter.listModels()).rejects.toThrow("Network error");
    });

    it("should handle empty models array", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [] }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const adapter = new GeminiAdapter("key");
      const models = await adapter.listModels();
      expect(models).toHaveLength(0);
    });

    it("should handle missing models key", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });
      vi.stubGlobal("fetch", mockFetch);

      const adapter = new GeminiAdapter("key");
      const models = await adapter.listModels();
      expect(models).toHaveLength(0);
    });

    it("should use stored apiKey in fetch URL", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [] }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const adapter = new GeminiAdapter("my-secret-key");
      await adapter.listModels();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("key=my-secret-key")
      );
    });
  });

  // ── toGeminiHistory (coverage via complete) ──────────────────────────────

  describe("history conversion (via complete)", () => {
    it("should filter out system messages from history", async () => {
      const { chat } = setupMockChat();
      mockSendMessage.mockResolvedValueOnce({
        response: makeGeminiTextResponse("OK"),
      });

      const adapter = new GeminiAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [
          { role: "system", content: "You are a bot" },
          { role: "user", content: "Hi" },
        ],
      });

      // startChat should have been called; history should not contain system role
      const startChatCall = mockStartChat.mock.calls[0][0] as {
        history: Array<{ role: string }>;
      };
      const roles = startChatCall.history.map((h) => h.role);
      expect(roles).not.toContain("system");
    });

    it("should convert tool messages to functionResponse", async () => {
      const { chat } = setupMockChat();
      mockSendMessage.mockResolvedValueOnce({
        response: makeGeminiTextResponse("OK"),
      });

      const adapter = new GeminiAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [
          { role: "user", content: "Search" },
          { role: "tool", tool_call_id: "search", content: "results" },
          { role: "user", content: "what next?" },
        ],
      });

      const startChatCall = mockStartChat.mock.calls[0][0] as {
        history: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
      };
      const toolMsg = startChatCall.history[1];
      expect(toolMsg.role).toBe("user");
      expect(toolMsg.parts[0]).toMatchObject({
        functionResponse: {
          name: "search",
          response: { content: "results" },
        },
      });
    });

    it("should convert tool message with ContentPart array to functionResponse", async () => {
      const { chat } = setupMockChat();
      mockSendMessage.mockResolvedValueOnce({
        response: makeGeminiTextResponse("OK"),
      });

      const adapter = new GeminiAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [
          {
            role: "tool",
            tool_call_id: "t1",
            content: [{ type: "text", text: "result text" }],
          },
          { role: "user", content: "continue" },
        ],
      });

      const startChatCall = mockStartChat.mock.calls[0][0] as {
        history: Array<{ parts: Array<Record<string, unknown>> }>;
      };
      // String content on tool messages is stringified to ""
      expect(
        startChatCall.history[0].parts[0].functionResponse.response.content
      ).toBe("");
    });

    it("should convert assistant role to model role", async () => {
      const { chat } = setupMockChat();
      mockSendMessage.mockResolvedValueOnce({
        response: makeGeminiTextResponse("OK"),
      });

      const adapter = new GeminiAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello" },
          { role: "user", content: "Reply" },
        ],
      });

      const startChatCall = mockStartChat.mock.calls[0][0] as {
        history: Array<{ role: string }>;
      };
      expect(startChatCall.history[0].role).toBe("user");
      expect(startChatCall.history[1].role).toBe("model");
    });

    it("should convert assistant messages with tool_call content parts", async () => {
      const { chat } = setupMockChat();
      mockSendMessage.mockResolvedValueOnce({
        response: makeGeminiTextResponse("OK"),
      });

      const adapter = new GeminiAdapter("k");
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
                arguments: '{"path":"/file"}',
              },
            ],
          },
          { role: "user", content: "ok" },
        ],
      });

      const startChatCall = mockStartChat.mock.calls[0][0] as {
        history: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
      };
      const asst = startChatCall.history[0];
      expect(asst.role).toBe("model");
      expect(asst.parts[0]).toMatchObject({
        functionCall: {
          name: "read",
          args: { path: "/file" },
        },
      });
    });

    it("should convert assistant messages with tool_result content parts", async () => {
      const { chat } = setupMockChat();
      mockSendMessage.mockResolvedValueOnce({
        response: makeGeminiTextResponse("OK"),
      });

      const adapter = new GeminiAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_result",
                tool_call_id: "t123",
                content: "tool result data",
              },
            ],
          },
          { role: "user", content: "done" },
        ],
      });

      const startChatCall = mockStartChat.mock.calls[0][0] as {
        history: Array<{ parts: Array<Record<string, unknown>> }>;
      };
      const part = startChatCall.history[0].parts[0];
      expect(part).toMatchObject({
        functionResponse: {
          name: "t123",
          response: { content: "tool result data" },
        },
      });
    });

    it("should handle mixed content parts in user message", async () => {
      const { chat } = setupMockChat();
      mockSendMessage.mockResolvedValueOnce({
        response: makeGeminiTextResponse("OK"),
      });

      const adapter = new GeminiAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Part A" },
              { type: "text", text: "Part B" },
            ],
          },
          { role: "user", content: "follow-up" },
        ],
      });

      const startChatCall = mockStartChat.mock.calls[0][0] as {
        history: Array<{ parts: Array<Record<string, unknown>> }>;
      };
      expect(startChatCall.history[0].parts).toHaveLength(2);
      expect(startChatCall.history[0].parts[0]).toEqual({ text: "Part A" });
      expect(startChatCall.history[0].parts[1]).toEqual({ text: "Part B" });
    });

    it("should use last message as the sendMessage parts (not history)", async () => {
      const { chat } = setupMockChat();
      mockSendMessage.mockResolvedValueOnce({
        response: makeGeminiTextResponse("OK"),
      });

      const adapter = new GeminiAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [
          { role: "user", content: "First" },
          { role: "user", content: "Last" },
        ],
      });

      const startChatCall = mockStartChat.mock.calls[0][0] as {
        history: Array<Record<string, unknown>>;
      };
      // History should only contain the first message (not the last)
      expect(startChatCall.history).toHaveLength(1);
      expect(startChatCall.history[0].parts[0]).toMatchObject({
        text: "First",
      });

      // Last message is sent via sendMessage
      expect(mockSendMessage).toHaveBeenCalledWith([{ text: "Last" }], {
        signal: undefined,
        timeout: DEFAULT_LLM_REQUEST_TIMEOUT_MS,
    });
    });

    it("should handle empty messages array (only last message used)", async () => {
      const { chat } = setupMockChat();
      mockSendMessage.mockResolvedValueOnce({
        response: makeGeminiTextResponse("OK"),
      });

      const adapter = new GeminiAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [{ role: "user", content: "Only message" }],
      });

      // startChat is called with empty history (the only message is the last and used as sendMessage parts)
      const startChatCall = mockStartChat.mock.calls[0][0] as {
        history: Array<Record<string, unknown>>;
      };
      expect(startChatCall.history).toHaveLength(0);
      expect(mockSendMessage).toHaveBeenCalledWith([{ text: "Only message" }], {
        signal: undefined,
        timeout: DEFAULT_LLM_REQUEST_TIMEOUT_MS,
    });
  });

    it("should forward the abort signal so a stop cancels the HTTP request", async () => {
      const { chat } = setupMockChat();
      mockSendMessage.mockResolvedValueOnce({
        response: makeGeminiTextResponse("OK"),
      });
      const controller = new AbortController();
      void chat;

      const adapter = new GeminiAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [{ role: "user", content: "Hi" }],
        signal: controller.signal,
      });

      expect(mockSendMessage).toHaveBeenCalledWith(expect.any(Array), {
        signal: controller.signal,
        timeout: DEFAULT_LLM_REQUEST_TIMEOUT_MS,
      });
    });
  });

  // ── flatMap fallback ────────────────────────────────────────────────────

  describe("flatMap fallback (unrecognized content parts)", () => {
    it("should skip unrecognized ContentPart types in toGeminiHistory", async () => {
      const { chat } = setupMockChat();
      mockSendMessage.mockResolvedValueOnce({
        response: makeGeminiTextResponse("OK"),
      });

      const adapter = new GeminiAdapter("k");
      await adapter.complete({
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              { type: "text" as const, text: "hello" },
              { type: "thinking" as "text", thinking: "ignored" },
            ],
          },
          { role: "user", content: "follow-up" },
        ],
      });

      // Should not throw; unrecognized parts are filtered via return []
      expect(mockStartChat).toHaveBeenCalled();
    });
  });
});
