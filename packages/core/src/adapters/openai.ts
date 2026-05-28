import OpenAI from "openai";
import type { LLMAdapter } from "./base.js";
import type {
  CompletionRequest,
  CompletionResponse,
  StreamEvent,
  Message,
  ContentPart,
} from "../types/index.js";
import type { ModelInfo } from "../types/model.js";

export class OpenAIAdapter implements LLMAdapter {
  private client: OpenAI;

  constructor(apiKey?: string, baseUrl?: string) {
    this.client = new OpenAI({ apiKey, baseURL: baseUrl });
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const response = await this.client.chat.completions.create({
      model: request.model,
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      messages: this.toOpenAIMessages(request),
      tools: this.toOpenAITools(request),
    });
    return this.fromOpenAIResponse(response);
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
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
    let usage: { input_tokens: number; output_tokens: number } | undefined;
    let reasoningTokens: number | undefined;

    try {
      for await (const chunk of apiStream) {
        const delta = chunk.choices[0]?.delta;
        finishReason = chunk.choices[0]?.finish_reason ?? finishReason;

        if (chunk.usage) {
          usage = {
            input_tokens: chunk.usage.prompt_tokens,
            output_tokens: chunk.usage.completion_tokens,
          };
          const details = (chunk.usage as unknown as Record<string, unknown>).completion_tokens_details as Record<string, unknown> | undefined;
          if (details?.reasoning_tokens != null) {
            reasoningTokens = details.reasoning_tokens as number;
          }
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
      usage: usage ? { ...usage, reasoning_tokens: reasoningTokens } : undefined,
    };
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
          .filter((p) => p.type === "text")
          .map((p) => ({
            type: "text" as const,
            text: (p as { text: string }).text,
          })),
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
      usage: response.usage
        ? {
            input_tokens: response.usage.prompt_tokens,
            output_tokens: response.usage.completion_tokens,
          }
        : undefined,
    };
  }
}
