import OpenAI from "openai";
import type { LLMAdapter } from "./base.js";
import { normalizeOpenAiBaseUrl } from "./base-url.js";
import type {
  CompletionRequest,
  CompletionResponse,
  StreamEvent,
  Message,
  ContentPart,
  Usage,
} from "../types/index.js";
import type { ModelInfo } from "../types/model.js";
import { createLogger } from "@open-vera/logger";

const log = createLogger("adapter:openai");

/** Map OpenAI / DeepSeek-compatible usage payloads onto Vera Usage (incl. cache). */
export function mapOpenAiUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  if (!Number.isFinite(inputTokens) && !Number.isFinite(outputTokens)) return undefined;

  const promptDetails =
    usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
      ? (usage.prompt_tokens_details as Record<string, unknown>)
      : undefined;
  const completionDetails =
    usage.completion_tokens_details && typeof usage.completion_tokens_details === "object"
      ? (usage.completion_tokens_details as Record<string, unknown>)
      : undefined;

  // OpenAI: prompt_tokens_details.cached_tokens; DeepSeek: prompt_cache_hit_tokens.
  const cacheRead = Number(
    usage.cache_read_input_tokens ??
      usage.prompt_cache_hit_tokens ??
      promptDetails?.cached_tokens ??
      0,
  );
  const cacheWrite = Number(
    usage.cache_creation_input_tokens ?? usage.cache_write_input_tokens ?? 0,
  );
  const reasoning = Number(
    usage.reasoning_tokens ?? completionDetails?.reasoning_tokens ?? 0,
  );

  const mapped: Usage = {
    input_tokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    output_tokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    // prompt_tokens already includes cache hits on OpenAI-compatible APIs.
    cache_included_in_input: true,
  };
  if (Number.isFinite(cacheRead) && cacheRead > 0) {
    mapped.cache_read_input_tokens = cacheRead;
  }
  if (Number.isFinite(cacheWrite) && cacheWrite > 0) {
    mapped.cache_creation_input_tokens = cacheWrite;
  }
  if (Number.isFinite(reasoning) && reasoning > 0) {
    mapped.reasoning_tokens = reasoning;
  }
  return mapped;
}

export class OpenAIAdapter implements LLMAdapter {
  private client: OpenAI;

  constructor(apiKey?: string, baseUrl?: string, headers?: Record<string, string>) {
    this.client = new OpenAI({
      apiKey,
      baseURL: normalizeOpenAiBaseUrl(baseUrl),
      defaultHeaders: headers,
    });
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const startMs = Date.now();
    try {
      const response = await this.client.chat.completions.create({
        model: request.model,
        max_tokens: request.max_tokens,
        temperature: request.temperature,
        messages: this.toOpenAIMessages(request),
        tools: this.toOpenAITools(request),
      });
      log.debug("complete done", { model: request.model, duration_ms: Date.now() - startMs, usage: response.usage });
      return this.fromOpenAIResponse(response);
    } catch (err) {
      log.warn("complete failed", { model: request.model, duration_ms: Date.now() - startMs, error: String(err) });
      throw err;
    }
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    const startMs = Date.now();
    // 累积 tool call（OpenAI 流式下发 index + 增量 arguments）
    const toolCalls: Record<
      number,
      { id: string; name: string; arguments: string }
    > = {};

    const apiStream = await this.client.chat.completions.create({
      model: request.model,
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      messages: this.toOpenAIMessages(request),
      tools: this.toOpenAITools(request),
      stream: true,
      stream_options: { include_usage: true },
    });

    let finishReason: string | null = null;
    let usage: Usage | undefined;

    try {
      for await (const chunk of apiStream) {
        const delta = chunk.choices[0]?.delta;
        finishReason = chunk.choices[0]?.finish_reason ?? finishReason;

        if (chunk.usage) {
          usage = mapOpenAiUsage(chunk.usage) ?? usage;
        }

        if (delta?.content) {
          yield { type: "text", text: delta.content };
        }

        // DeepSeek / OpenAI-compatible reasoning_content
        const deltaAny = delta as Record<string, unknown> | undefined;
        if (typeof deltaAny?.reasoning_content === "string" && deltaAny.reasoning_content) {
          yield { type: "thinking", text: deltaAny.reasoning_content };
        }

        for (const tc of delta?.tool_calls ?? []) {
          if (!toolCalls[tc.index]) {
            toolCalls[tc.index] = {
              id: tc.id ?? "",
              name: tc.function?.name ?? "",
              arguments: "",
            };
          }
          toolCalls[tc.index].arguments += tc.function?.arguments ?? "";
        }
      }
    } catch (err) {
      throw err;
    }

    for (const tc of Object.values(toolCalls)) {
      yield {
        type: "tool_call",
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      };
    }

    yield {
      type: "done",
      stop_reason: finishReason === "tool_calls" ? "tool_use" : "end_turn",
      usage,
    };
    log.debug("stream done", { model: request.model, duration_ms: Date.now() - startMs, usage });
  }

  async listModels(): Promise<ModelInfo[]> {
    const page = await this.client.models.list();
    return page.data.map((m) => ({ id: m.id, created: m.created }));
  }

  private toOpenAIMessages(
    request: CompletionRequest
  ): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = [];

    if (request.system) {
      result.push({ role: "system", content: request.system });
    }

    for (const msg of request.messages) {
      if (msg.role === "system") {
        result.push({
          role: "system",
          content: typeof msg.content === "string" ? msg.content : "",
        });
        continue;
      }
      if (msg.role === "tool") {
        result.push({
          role: "tool",
          tool_call_id: msg.tool_call_id!,
          content: typeof msg.content === "string" ? msg.content : "",
        });
        continue;
      }
      if (typeof msg.content === "string") {
        result.push({ role: msg.role, content: msg.content });
        continue;
      }
      if (msg.role === "assistant") {
        const textParts = msg.content.filter((p) => p.type === "text");
        const toolCalls = msg.content.filter((p) => p.type === "tool_call");
        result.push({
          role: "assistant",
          content: textParts.map((p) => ({
            type: "text" as const,
            text: (p as { text: string }).text,
          })),
          tool_calls: toolCalls.map((p) => {
            const tc = p as { id: string; name: string; arguments: string };
            return {
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: tc.arguments },
            };
          }),
        });
        continue;
      }
      result.push({
        role: "user",
        content: msg.content
          .filter((p) => p.type === "text" || p.type === "image_url")
          .map((p) => {
            if (p.type === "image_url") {
              return {
                type: "image_url" as const,
                image_url: p.image_url,
              };
            }
            return {
              type: "text" as const,
              text: p.text,
            };
          }),
      });
    }

    return result;
  }

  private toOpenAITools(
    request: CompletionRequest
  ): OpenAI.ChatCompletionTool[] | undefined {
    const tools = (request.tools ?? []).map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
    return tools.length > 0 ? tools : undefined;
  }

  private fromOpenAIResponse(
    response: OpenAI.ChatCompletion
  ): CompletionResponse {
    const choice = response.choices[0];
    const msg = choice.message;
    const parts: ContentPart[] = [];

    if (msg.content) parts.push({ type: "text", text: msg.content });

    for (const tc of msg.tool_calls ?? []) {
      if (tc.type !== "function") continue;
      parts.push({
        type: "tool_call",
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      });
    }

    const message: Message = {
      role: "assistant",
      content:
        parts.length === 1 && parts[0].type === "text"
          ? (parts[0] as { text: string }).text
          : parts,
    };

    return {
      message,
      stop_reason:
        choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn",
      usage: mapOpenAiUsage(response.usage),
    };
  }
}
