// visual_analyze — 视觉理解工具
//
// 截图后送 LLM 分析，生成下一步操作建议
// 支持：截图文件路径、base64 图片数据

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { ToolDef, ToolResult, ToolContext } from "./types.js";
import { errorResult } from "./types.js";
import type { LLMAdapter } from "../adapters/base.js";
import type { LlmRequestOptions } from "../adapters/llm-service.js";

export interface VisualAnalyzeArgs {
  /** Path to the screenshot/image file */
  imagePath?: string;
  /** Base64-encoded image data (alternative to imagePath) */
  imageData?: string;
  /** MIME type of the image (required when using imageData) */
  mimeType?: string;
  /** Custom analysis prompt (default: general analysis + action suggestions) */
  prompt?: string;
  /** Model to use for analysis (default: claude-sonnet-4-6) */
  model?: string;
  /** Max tokens for the analysis response */
  maxTokens?: number;
}

const DEFAULT_PROMPT =
  "Analyze this screenshot in detail. Describe what you see, " +
  "identify any UI elements, text content, and the current state of the application. " +
  "Then suggest specific next actions the user could take (e.g., click a button, " +
  "type in a field, navigate to a page). Format your response as:\n\n" +
  "## Description\n[What you see in the screenshot]\n\n" +
  "## Key Elements\n- [List of important UI elements]\n\n" +
  "## Suggested Actions\n1. [First suggested action]\n2. [Second suggested action]\n...";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 2048;

export interface VisionLlmServiceLike {
  complete(
    request: Parameters<LLMAdapter["complete"]>[0],
    options?: LlmRequestOptions,
  ): ReturnType<LLMAdapter["complete"]>;
}

export type VisualAnalyzeLlm = LLMAdapter | VisionLlmServiceLike;

function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
  };
  return mimeMap[ext] ?? "image/png";
}

export function createVisualAnalyzeTool(
  llm: VisualAnalyzeLlm,
  defaultModel?: string,
): ToolDef<VisualAnalyzeArgs> {
  return {
    name: "visual_analyze",
    description:
      "Analyze a screenshot or image using LLM vision capabilities. " +
      "Provides detailed description of the image content, identifies UI elements, " +
      "and suggests next actions. Use after taking a screenshot to understand what's on screen.",
    parameters: {
      type: "object",
      properties: {
        imagePath: {
          type: "string",
          description: "Path to the screenshot or image file to analyze",
        },
        imageData: {
          type: "string",
          description: "Base64-encoded image data (alternative to imagePath)",
        },
        mimeType: {
          type: "string",
          description: "MIME type of the image (required when using imageData, e.g., 'image/png')",
        },
        prompt: {
          type: "string",
          description: "Custom analysis prompt (default: general analysis with action suggestions)",
        },
        model: {
          type: "string",
          description: "Model to use for analysis (default: claude-sonnet-4-6)",
        },
        maxTokens: {
          type: "number",
          description: "Max tokens for the analysis response (default: 2048)",
        },
      },
      required: [],
    },
    options: { timeoutMs: 60_000, riskLevel: "low" },

    async execute(args: VisualAnalyzeArgs, _ctx: ToolContext): Promise<ToolResult> {
      // Resolve image data
      let base64Data: string;
      let mimeType: string;

      if (args.imageData) {
        base64Data = args.imageData;
        mimeType = args.mimeType ?? "image/png";
      } else if (args.imagePath) {
        try {
          const buffer = await readFile(args.imagePath);
          base64Data = buffer.toString("base64");
          mimeType = args.mimeType ?? getMimeType(args.imagePath);
        } catch (err) {
          return errorResult(
            "NOT_FOUND",
            `Failed to read image file: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        return errorResult(
          "UNKNOWN",
          "Either imagePath or imageData is required for visual analysis.",
        );
      }

      const model = args.model ?? defaultModel ?? DEFAULT_MODEL;
      const prompt = args.prompt ?? DEFAULT_PROMPT;

      try {
        const response = await completeVision(llm, {
          model,
          max_tokens: args.maxTokens ?? DEFAULT_MAX_TOKENS,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: {
                    url: `data:${mimeType};base64,${base64Data}`,
                  },
                },
                {
                  type: "text",
                  text: prompt,
                },
              ],
            },
          ],
        });

        const content =
          typeof response.message.content === "string"
            ? response.message.content
            : response.message.content
                .filter((p): p is { type: "text"; text: string } => p.type === "text")
                .map((p) => p.text)
                .join("\n");

        return {
          ok: true,
          content,
          metadata: {
            renderHint: { type: "text" },
          },
        };
      } catch (err) {
        return errorResult(
          "EXEC_ERROR",
          `Visual analysis failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}

function completeVision(
  llm: VisualAnalyzeLlm,
  request: Parameters<LLMAdapter["complete"]>[0],
): ReturnType<LLMAdapter["complete"]> {
  if (isVisionLlmService(llm)) {
    return llm.complete(request, { model: request.model, purpose: "vision" });
  }
  return (llm as LLMAdapter).complete(request);
}

function isVisionLlmService(value: VisualAnalyzeLlm): value is VisionLlmServiceLike {
  return typeof (value as VisionLlmServiceLike).complete === "function"
    && (
      !("stream" in value)
      || "buildAdapter" in value
      || "selectAdapter" in value
    );
}
