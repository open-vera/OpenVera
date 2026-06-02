/**
 * Comprehensive unit tests for intent classifier (classifier.ts)
 *
 * Covers: extractJson (via classifyIntent), classifyIntent, routeTarget,
 * shouldPlan, resolveModel, and all edge cases.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  classifyIntent,
  routeTarget,
  shouldPlan,
  resolveModel,
} from "../classifier.js";
import type { LLMAdapter } from "../../adapters/base.js";
import type { RoutingConfig } from "../../config/types.js";
import type { CompletionResponse, Usage } from "../../types/index.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function mockComplete(overrides: Partial<CompletionResponse> = {}) {
  return vi.fn().mockResolvedValue({
    message: { role: "assistant" as const, content: "{}" },
    stop_reason: "end_turn" as const,
    ...overrides,
  });
}

function makeAdapter(
  response: Partial<CompletionResponse> = {},
): LLMAdapter {
  return {
    complete: mockComplete(response),
    stream: vi.fn() as unknown as LLMAdapter["stream"],
  } as unknown as LLMAdapter;
}

function intentJson(props: Record<string, unknown> = {}) {
  return JSON.stringify({
    level: 0,
    needs_tools: false,
    needs_planning: false,
    domain: "chat",
    reason: "test",
    ...props,
  });
}

// ── classifyIntent ─────────────────────────────────────────────────────────

describe("classifyIntent", () => {
  let adapter: LLMAdapter;

  beforeEach(() => {
    adapter = makeAdapter();
  });

  it("should classify with string content", async () => {
    (adapter.complete as ReturnType<typeof vi.fn>).mockResolvedValue({
      message: {
        role: "assistant",
        content: intentJson({ level: 2, domain: "code" }),
      },
      stop_reason: "end_turn",
    });

    const result = await classifyIntent("write a function", adapter, "test-model");
    expect(result.level).toBe(2);
    expect(result.domain).toBe("code");
    expect(result.reason).toBe("test");
  });

  it("should classify with text content parts (array)", async () => {
    (adapter.complete as ReturnType<typeof vi.fn>).mockResolvedValue({
      message: {
        role: "assistant",
        content: [
          { type: "text", text: intentJson({ level: 1, domain: "writing" }) },
        ],
      },
      stop_reason: "end_turn",
    });

    const result = await classifyIntent("draft an email", adapter, "test-model");
    expect(result.level).toBe(1);
    expect(result.domain).toBe("writing");
  });

  it("should call onUsage when usage is present", async () => {
    const usage: Usage = {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    (adapter.complete as ReturnType<typeof vi.fn>).mockResolvedValue({
      message: { role: "assistant", content: intentJson({ level: 0 }) },
      stop_reason: "end_turn",
      usage,
    });

    const onUsage = vi.fn();
    await classifyIntent("hello", adapter, "test-model", onUsage);

    expect(onUsage).toHaveBeenCalledWith(usage);
  });

  it("should NOT call onUsage when usage is absent", async () => {
    (adapter.complete as ReturnType<typeof vi.fn>).mockResolvedValue({
      message: { role: "assistant", content: intentJson() },
      stop_reason: "end_turn",
    });

    const onUsage = vi.fn();
    await classifyIntent("hello", adapter, "test-model", onUsage);

    expect(onUsage).not.toHaveBeenCalled();
  });

  it("should extract JSON from fenced code block", async () => {
    const fenced = "```json\n" + intentJson({ level: 3, domain: "analysis" }) + "\n```";
    (adapter.complete as ReturnType<typeof vi.fn>).mockResolvedValue({
      message: { role: "assistant", content: fenced },
      stop_reason: "end_turn",
    });

    const result = await classifyIntent("complex analysis", adapter, "test-model");
    expect(result.level).toBe(3);
    expect(result.domain).toBe("analysis");
  });

  it("should extract JSON from raw text (finding braces)", async () => {
    const withPrefix =
      "Here is the analysis:\n" + intentJson({ level: 1 }) + "\nHope that helps.";
    (adapter.complete as ReturnType<typeof vi.fn>).mockResolvedValue({
      message: { role: "assistant", content: withPrefix },
      stop_reason: "end_turn",
    });

    const result = await classifyIntent("task", adapter, "test-model");
    expect(result.level).toBe(1);
  });

  it("should extract JSON from unfenced ``` block", async () => {
    const fenced = "```\n" + intentJson({ level: 2 }) + "\n```";
    (adapter.complete as ReturnType<typeof vi.fn>).mockResolvedValue({
      message: { role: "assistant", content: fenced },
      stop_reason: "end_turn",
    });

    const result = await classifyIntent("task", adapter, "test-model");
    expect(result.level).toBe(2);
  });

  it("should filter non-text parts from content array", async () => {
    (adapter.complete as ReturnType<typeof vi.fn>).mockResolvedValue({
      message: {
        role: "assistant",
        content: [
          { type: "tool_use" as const, name: "bash", input: {} },
          { type: "text", text: intentJson({ level: 0 }) },
        ],
      },
      stop_reason: "end_turn",
    });

    const result = await classifyIntent("task", adapter, "test-model");
    expect(result.level).toBe(0);
  });

  it("should join multiple text parts", async () => {
    const first = '{"level":0,"needs_tools":false,"needs_planning":false,"domain":';
    const second = '"chat","reason":"multi-part"}';
    (adapter.complete as ReturnType<typeof vi.fn>).mockResolvedValue({
      message: {
        role: "assistant",
        content: [
          { type: "text", text: first },
          { type: "text", text: second },
        ],
      },
      stop_reason: "end_turn",
    });

    const result = await classifyIntent("task", adapter, "test-model");
    expect(result.domain).toBe("chat");
    expect(result.reason).toBe("multi-part");
  });

  it("should pass the classifier model and system prompt to adapter", async () => {
    const complete = mockComplete({
      message: { role: "assistant", content: intentJson() },
    });
    const adp = { complete, stream: vi.fn() } as unknown as LLMAdapter;

    await classifyIntent("hello", adp, "claude-haiku-4-5");

    expect(complete).toHaveBeenCalledTimes(1);
    const req = complete.mock.calls[0][0];
    expect(req.model).toBe("claude-haiku-4-5");
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0].role).toBe("user");
    expect(req.messages[0].content).toBe("hello");
    expect(req.system).toContain("Classify the user task");
  });
});

// ── routeTarget ────────────────────────────────────────────────────────────

describe("routeTarget", () => {
  const defaultIntent = {
    level: 0 as const,
    needs_tools: false,
    needs_planning: false,
    domain: "chat" as const,
    reason: "test",
  };

  it("should route level 0 from config", () => {
    const routing: RoutingConfig = {
      l0: { provider: "openai", model: "gpt-4o" },
    };
    const target = routeTarget(defaultIntent, routing);
    expect(target).toEqual({ provider: "openai", model: "gpt-4o" });
  });

  it("should route level 1 from config", () => {
    const routing: RoutingConfig = {
      l1: { provider: "anthropic", model: "claude-sonnet-4" },
    };
    const target = routeTarget({ ...defaultIntent, level: 1 }, routing);
    expect(target).toEqual({ provider: "anthropic", model: "claude-sonnet-4" });
  });

  it("should route level 2 from config", () => {
    const routing: RoutingConfig = {
      l2: { provider: "gemini", model: "gemini-pro" },
    };
    const target = routeTarget({ ...defaultIntent, level: 2 }, routing);
    expect(target).toEqual({ provider: "gemini", model: "gemini-pro" });
  });

  it("should route level 3 from config", () => {
    const routing: RoutingConfig = {
      l3: { provider: "anthropic", model: "claude-opus-5" },
    };
    const target = routeTarget({ ...defaultIntent, level: 3 }, routing);
    expect(target).toEqual({ provider: "anthropic", model: "claude-opus-5" });
  });

  it("should fall back to DEFAULT_ROUTING when config key is missing", () => {
    const routing: RoutingConfig = {};
    // Level 1 fallback: claude-haiku-4-5
    const target = routeTarget({ ...defaultIntent, level: 1 }, routing);
    expect(target).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
  });

  it("should use DEFAULT_ROUTING for each level when empty config", () => {
    const routing: RoutingConfig = {};
    expect(routeTarget({ ...defaultIntent, level: 0 }, routing).model).toBe("claude-haiku-4-5");
    expect(routeTarget({ ...defaultIntent, level: 1 }, routing).model).toBe("claude-haiku-4-5");
    expect(routeTarget({ ...defaultIntent, level: 2 }, routing).model).toBe("claude-sonnet-4-6");
    expect(routeTarget({ ...defaultIntent, level: 3 }, routing).model).toBe("claude-opus-4-6");
  });

  it("should prefer config value over default when both exist", () => {
    const routing: RoutingConfig = {
      l0: { provider: "openai", model: "gpt-4" },
    };
    const target = routeTarget(defaultIntent, routing);
    // Config takes precedence
    expect(target.provider).toBe("openai");
    expect(target.model).toBe("gpt-4");
  });
});

// ── shouldPlan ─────────────────────────────────────────────────────────────

describe("shouldPlan", () => {
  it("should return false for level 0", () => {
    expect(
      shouldPlan({
        level: 0,
        needs_tools: false,
        needs_planning: false,
        domain: "chat",
        reason: "",
      }),
    ).toBe(false);
  });

  it("should return false for level 1", () => {
    expect(
      shouldPlan({
        level: 1,
        needs_tools: true,
        needs_planning: false,
        domain: "code",
        reason: "",
      }),
    ).toBe(false);
  });

  it("should return false for level 2", () => {
    expect(
      shouldPlan({
        level: 2,
        needs_tools: true,
        needs_planning: false,
        domain: "search",
        reason: "",
      }),
    ).toBe(false);
  });

  it("should return true for level 3", () => {
    expect(
      shouldPlan({
        level: 3,
        needs_tools: true,
        needs_planning: true,
        domain: "analysis",
        reason: "",
      }),
    ).toBe(true);
  });
});

// ── resolveModel ───────────────────────────────────────────────────────────

describe("resolveModel", () => {
  let adapter: LLMAdapter;

  beforeEach(() => {
    adapter = makeAdapter();
  });

  it("should return routed model on success", async () => {
    (adapter.complete as ReturnType<typeof vi.fn>).mockResolvedValue({
      message: {
        role: "assistant",
        content: intentJson({ level: 2, domain: "code" }),
      },
      stop_reason: "end_turn",
    });
    const routing: RoutingConfig = {
      l2: { provider: "anthropic", model: "claude-sonnet-4-6" },
    };

    const result = await resolveModel(
      "write test",
      adapter,
      "classifier-model",
      routing,
      "openai",
      "gpt-4",
    );

    expect(result.model).toBe("claude-sonnet-4-6");
    expect(result.provider).toBe("anthropic");
    expect(result.intent).not.toBeNull();
    expect(result.intent!.level).toBe(2);
  });

  it("should call onUsage when provided", async () => {
    const usage: Usage = {
      input_tokens: 50,
      output_tokens: 25,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    (adapter.complete as ReturnType<typeof vi.fn>).mockResolvedValue({
      message: { role: "assistant", content: intentJson({ level: 0 }) },
      stop_reason: "end_turn",
      usage,
    });

    const onUsage = vi.fn();
    await resolveModel(
      "hello",
      adapter,
      "model",
      {},
      "fb",
      "fallback",
      onUsage,
    );

    expect(onUsage).toHaveBeenCalledWith(usage);
  });

  it("should re-throw errors (not silently fall back)", async () => {
    const error = new Error("LLM connection refused");
    (adapter.complete as ReturnType<typeof vi.fn>).mockRejectedValue(error);

    await expect(
      resolveModel("hello", adapter, "model", {}, "fb", "fallback"),
    ).rejects.toThrow("LLM connection refused");
  });

  it("should use default routing when config does not cover intent level", async () => {
    (adapter.complete as ReturnType<typeof vi.fn>).mockResolvedValue({
      message: {
        role: "assistant",
        content: intentJson({ level: 3, domain: "analysis" }),
      },
      stop_reason: "end_turn",
    });
    const routing: RoutingConfig = {}; // no l3 defined

    const result = await resolveModel(
      "complex plan",
      adapter,
      "model",
      routing,
      "fb",
      "fallback",
    );

    expect(result.model).toBe("claude-opus-4-6");
    expect(result.provider).toBe("anthropic");
  });
});
