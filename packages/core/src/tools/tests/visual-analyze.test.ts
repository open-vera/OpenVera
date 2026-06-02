/**
 * Tests for visual_analyze tool (CU11)
 *
 * Verifies: screenshot analysis, image data handling, LLM integration,
 * error handling, model/prompt customization.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolContext } from "../types.js";
import type { LLMAdapter } from "../../adapters/base.js";
import type { CompletionResponse } from "../../types/completion.js";
import { fileURLToPath } from "node:url";

// ── Mock LLM Adapter ─────────────────────────────────────────────────────────

function createMockAdapter(response: string): LLMAdapter {
  return {
    complete: vi.fn().mockResolvedValue({
      message: {
        role: "assistant",
        content: response,
      },
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 200 },
    } satisfies CompletionResponse),
    stream: vi.fn(),
  };
}

function createMockAdapterWithParts(response: string): LLMAdapter {
  return {
    complete: vi.fn().mockResolvedValue({
      message: {
        role: "assistant",
        content: [
          { type: "text", text: response },
        ],
      },
      stop_reason: "end_turn",
    } satisfies CompletionResponse),
    stream: vi.fn(),
  };
}

function createFailingAdapter(error: Error): LLMAdapter {
  return {
    complete: vi.fn().mockRejectedValue(error),
    stream: vi.fn(),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockCtx: ToolContext = {
  cwd: "/tmp/test",
  sessionId: "test-session",
};

const SAMPLE_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// ── Import after setup ────────────────────────────────────────────────────────

import { createVisualAnalyzeTool } from "../visual-analyze.js";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("CU11: visual_analyze tool", () => {
  // ── Tool registration ─────────────────────────────────────────────────────

  it("should have correct name and description", () => {
    const tool = createVisualAnalyzeTool(createMockAdapter("test"));
    expect(tool.name).toBe("visual_analyze");
    expect(tool.description).toContain("Analyze a screenshot");
    expect(tool.description).toContain("LLM vision");
  });

  it("should have all expected parameters", () => {
    const tool = createVisualAnalyzeTool(createMockAdapter("test"));
    const props = (tool.parameters as { properties: Record<string, unknown> }).properties;
    expect(props.imagePath).toBeDefined();
    expect(props.imageData).toBeDefined();
    expect(props.mimeType).toBeDefined();
    expect(props.prompt).toBeDefined();
    expect(props.model).toBeDefined();
    expect(props.maxTokens).toBeDefined();
  });

  // ── Image data analysis ───────────────────────────────────────────────────

  it("should analyze base64 image data", async () => {
    const mockResponse = "## Description\nA test image.\n\n## Suggested Actions\n1. Click OK";
    const adapter = createMockAdapter(mockResponse);
    const tool = createVisualAnalyzeTool(adapter);

    const result = await tool.execute(
      { imageData: SAMPLE_BASE64, mimeType: "image/png" },
      mockCtx,
    );

    expect(result.ok).toBe(true);
    expect(result.content).toBe(mockResponse);
    expect(adapter.complete).toHaveBeenCalledOnce();
  });

  it("should use default mime type when not specified", async () => {
    const adapter = createMockAdapter("analysis result");
    const tool = createVisualAnalyzeTool(adapter);

    await tool.execute({ imageData: SAMPLE_BASE64 }, mockCtx);

    const call = (adapter.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const imagePart = call.messages[0].content[0];
    expect(imagePart.image_url.url).toMatch(/^data:image\/png;base64,/);
  });

  it("should use specified mime type", async () => {
    const adapter = createMockAdapter("analysis result");
    const tool = createVisualAnalyzeTool(adapter);

    await tool.execute({ imageData: SAMPLE_BASE64, mimeType: "image/jpeg" }, mockCtx);

    const call = (adapter.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const imagePart = call.messages[0].content[0];
    expect(imagePart.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
  });

  // ── Image file analysis ───────────────────────────────────────────────────

  it("should analyze image from file path", async () => {
    const mockResponse = "Screenshot shows a browser with example.com loaded.";
    const adapter = createMockAdapter(mockResponse);
    const tool = createVisualAnalyzeTool(adapter);

    // Use a real file path that exists (this file itself)
    const selfPath = fileURLToPath(import.meta.url);
    const result = await tool.execute(
      { imagePath: selfPath },
      mockCtx,
    );

    expect(result.ok).toBe(true);
    expect(result.content).toBe(mockResponse);
    expect(adapter.complete).toHaveBeenCalledOnce();
  });

  it("should return error for non-existent file", async () => {
    const adapter = createMockAdapter("should not reach");
    const tool = createVisualAnalyzeTool(adapter);

    const result = await tool.execute(
      { imagePath: "/nonexistent/path/screenshot.png" },
      mockCtx,
    );

    expect(result.ok).toBe(false);
    expect(result.content).toContain("Failed to read image file");
  });

  it("should detect mime type from file extension", async () => {
    const adapter = createMockAdapter("result");
    const tool = createVisualAnalyzeTool(adapter);

    // Create a temp file with .jpg extension to test mime detection
    const { writeFile, unlink, mkdir } = await import("node:fs/promises");
    const tmpDir = "/tmp/visual-analyze-test";
    await mkdir(tmpDir, { recursive: true });
    const tmpFile = `${tmpDir}/test.jpg`;
    await writeFile(tmpFile, Buffer.from(SAMPLE_BASE64, "base64"));

    try {
      await tool.execute({ imagePath: tmpFile }, mockCtx);

      const call = (adapter.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const imagePart = call.messages[0].content[0];
      expect(imagePart.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    } finally {
      await unlink(tmpFile);
    }
  });

  // ── Missing input ─────────────────────────────────────────────────────────

  it("should return error when neither imagePath nor imageData provided", async () => {
    const adapter = createMockAdapter("should not reach");
    const tool = createVisualAnalyzeTool(adapter);

    const result = await tool.execute({}, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.content).toContain("Either imagePath or imageData is required");
  });

  // ── LLM call structure ────────────────────────────────────────────────────

  it("should send image and prompt as user message", async () => {
    const adapter = createMockAdapter("result");
    const tool = createVisualAnalyzeTool(adapter);

    await tool.execute({ imageData: SAMPLE_BASE64 }, mockCtx);

    const call = (adapter.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.messages).toHaveLength(1);
    expect(call.messages[0].role).toBe("user");
    expect(call.messages[0].content).toHaveLength(2);
    expect(call.messages[0].content[0].type).toBe("image_url");
    expect(call.messages[0].content[1].type).toBe("text");
  });

  it("should use default prompt when not specified", async () => {
    const adapter = createMockAdapter("result");
    const tool = createVisualAnalyzeTool(adapter);

    await tool.execute({ imageData: SAMPLE_BASE64 }, mockCtx);

    const call = (adapter.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const textPart = call.messages[0].content[1];
    expect(textPart.text).toContain("Analyze this screenshot");
    expect(textPart.text).toContain("Suggested Actions");
  });

  it("should use custom prompt when provided", async () => {
    const adapter = createMockAdapter("result");
    const tool = createVisualAnalyzeTool(adapter);

    await tool.execute(
      { imageData: SAMPLE_BASE64, prompt: "What buttons are visible?" },
      mockCtx,
    );

    const call = (adapter.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const textPart = call.messages[0].content[1];
    expect(textPart.text).toBe("What buttons are visible?");
  });

  // ── Model selection ───────────────────────────────────────────────────────

  it("should use default model when not specified", async () => {
    const adapter = createMockAdapter("result");
    const tool = createVisualAnalyzeTool(adapter);

    await tool.execute({ imageData: SAMPLE_BASE64 }, mockCtx);

    const call = (adapter.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.model).toBe("claude-sonnet-4-6");
  });

  it("should use custom model when provided", async () => {
    const adapter = createMockAdapter("result");
    const tool = createVisualAnalyzeTool(adapter);

    await tool.execute(
      { imageData: SAMPLE_BASE64, model: "claude-opus-4-7" },
      mockCtx,
    );

    const call = (adapter.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.model).toBe("claude-opus-4-7");
  });

  it("should use factory default model when provided", async () => {
    const adapter = createMockAdapter("result");
    const tool = createVisualAnalyzeTool(adapter, "gpt-4o");

    await tool.execute({ imageData: SAMPLE_BASE64 }, mockCtx);

    const call = (adapter.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.model).toBe("gpt-4o");
  });

  it("should prefer args.model over factory default", async () => {
    const adapter = createMockAdapter("result");
    const tool = createVisualAnalyzeTool(adapter, "gpt-4o");

    await tool.execute(
      { imageData: SAMPLE_BASE64, model: "claude-opus-4-7" },
      mockCtx,
    );

    const call = (adapter.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.model).toBe("claude-opus-4-7");
  });

  // ── Max tokens ────────────────────────────────────────────────────────────

  it("should use default max_tokens when not specified", async () => {
    const adapter = createMockAdapter("result");
    const tool = createVisualAnalyzeTool(adapter);

    await tool.execute({ imageData: SAMPLE_BASE64 }, mockCtx);

    const call = (adapter.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.max_tokens).toBe(2048);
  });

  it("should use custom max_tokens when provided", async () => {
    const adapter = createMockAdapter("result");
    const tool = createVisualAnalyzeTool(adapter);

    await tool.execute(
      { imageData: SAMPLE_BASE64, maxTokens: 4096 },
      mockCtx,
    );

    const call = (adapter.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.max_tokens).toBe(4096);
  });

  // ── Response parsing ──────────────────────────────────────────────────────

  it("should handle string content response", async () => {
    const adapter = createMockAdapter("plain text response");
    const tool = createVisualAnalyzeTool(adapter);

    const result = await tool.execute({ imageData: SAMPLE_BASE64 }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toBe("plain text response");
  });

  it("should handle ContentPart array response", async () => {
    const adapter = createMockAdapterWithParts("text from parts");
    const tool = createVisualAnalyzeTool(adapter);

    const result = await tool.execute({ imageData: SAMPLE_BASE64 }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toBe("text from parts");
  });

  // ── Error handling ────────────────────────────────────────────────────────

  it("should handle LLM adapter errors gracefully", async () => {
    const adapter = createFailingAdapter(new Error("API rate limit exceeded"));
    const tool = createVisualAnalyzeTool(adapter);

    const result = await tool.execute({ imageData: SAMPLE_BASE64 }, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.content).toContain("Visual analysis failed");
    expect(result.content).toContain("API rate limit exceeded");
  });

  it("should handle non-Error exceptions", async () => {
    const adapter = {
      complete: vi.fn().mockRejectedValue("string error"),
      stream: vi.fn(),
    };
    const tool = createVisualAnalyzeTool(adapter);

    const result = await tool.execute({ imageData: SAMPLE_BASE64 }, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.content).toContain("Visual analysis failed");
  });
});
