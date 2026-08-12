import OpenAI from "openai";
import type { LLMAdapter } from "./base.js";
import { normalizeOpenAiBaseUrl } from "./base-url.js";
import type {
  CompletionRequest,
  CompletionResponse,
  StreamEvent,
  Message,
  ContentPart,
  StopReason,
} from "../types/index.js";
import type { ModelInfo } from "../types/model.js";
import { createLogger } from "@open-vera/logger";
import { resolveLlmRequestTimeoutMs } from "./timeouts.js";

const log = createLogger("adapter:openai-responses");

type ResponseInputItem = OpenAI.Responses.ResponseInputItem;
type ResponseOutputItem = OpenAI.Responses.ResponseOutputItem;

/**
 * Adapter for the OpenAI Responses API (`/v1/responses`).
 *
 * Vera 每轮都会回放完整历史，所以固定 `store: false`，不依赖
 * 服务端的 previous_response_id 状态链。
 */
export class OpenAIResponsesAdapter implements LLMAdapter {
  private client: OpenAI;

  constructor(
    apiKey?: string,
    baseUrl?: string,
    headers?: Record<string, string>
  ) {
    this.client = new OpenAI({
      apiKey,
      baseURL: normalizeOpenAiBaseUrl(baseUrl),
      defaultHeaders: headers,
      timeout: resolveLlmRequestTimeoutMs(),
    });
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const startMs = Date.now();
    try {
      const response = await this.client.responses.create(
        {
        model: request.model,
        input: this.toResponseInput(request),
        tools: this.toResponseTools(request),
        store: false,
        ...(request.system ? { instructions: request.system } : {}),
          ...(request.max_tokens != null
            ? { max_output_tokens: request.max_tokens }
            : {}),
          ...(request.temperature != null
            ? { temperature: request.temperature }
            : {}),
        },
        // Without the signal a "stop" only flips a flag; the HTTP request runs
        // to completion and the agent keeps spending tokens.
        { signal: request.signal }
      );
      log.debug("complete done", {
        model: request.model,
        duration_ms: Date.now() - startMs,
        usage: response.usage,
      });
      return this.fromResponse(response);
    } catch (err) {
      log.warn("complete failed", {
        model: request.model,
        duration_ms: Date.now() - startMs,
        error: String(err),
      });
      throw err;
    }
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    const startMs = Date.now();
    const apiStream = await this.client.responses.create(
      {
      model: request.model,
      input: this.toResponseInput(request),
      tools: this.toResponseTools(request),
      store: false,
      stream: true,
      ...(request.system ? { instructions: request.system } : {}),
        ...(request.max_tokens != null
          ? { max_output_tokens: request.max_tokens }
          : {}),
        ...(request.temperature != null
          ? { temperature: request.temperature }
          : {}),
      },
      { signal: request.signal }
    );

    let sawToolCall = false;
    let stopReason: StopReason = "end_turn";
    let usage: CompletionResponse["usage"];

    for await (const event of apiStream) {
      switch (event.type) {
        case "response.output_text.delta":
          if (event.delta) yield { type: "text", text: event.delta };
          break;
        case "response.reasoning_summary_text.delta":
          if (event.delta) yield { type: "thinking", text: event.delta };
          break;
        case "response.output_item.done":
          if (event.item.type === "function_call") {
            sawToolCall = true;
            yield {
              type: "tool_call",
              id: event.item.call_id,
              name: event.item.name,
              arguments: event.item.arguments,
            };
          }
          break;
        case "response.completed":
        case "response.incomplete": {
          const response = event.response;
          if (response.usage) {
            usage = {
              input_tokens: response.usage.input_tokens,
              output_tokens: response.usage.output_tokens,
              ...(response.usage.output_tokens_details?.reasoning_tokens != null
                ? {
                    reasoning_tokens:
                      response.usage.output_tokens_details.reasoning_tokens,
                  }
                : {}),
            };
          }
          if (response.incomplete_details?.reason === "max_output_tokens") {
            stopReason = "max_tokens";
          }
          break;
        }
        case "response.failed": {
          const message =
            event.response.error?.message ?? "OpenAI response failed";
          throw new Error(message);
        }
        case "error":
          throw new Error(event.message);
      }
    }

    yield {
      type: "done",
      stop_reason: sawToolCall ? "tool_use" : stopReason,
      ...(usage ? { usage } : {}),
    };
    log.debug("stream done", {
      model: request.model,
      duration_ms: Date.now() - startMs,
      usage,
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    const page = await this.client.models.list();
    return page.data.map((m) => ({ id: m.id, created: m.created }));
  }

  private toResponseInput(request: CompletionRequest): ResponseInputItem[] {
    const items: ResponseInputItem[] = [];

    for (const msg of request.messages) {
      if (msg.role === "tool") {
        items.push({
          type: "function_call_output",
          call_id: msg.tool_call_id ?? "",
          output: typeof msg.content === "string" ? msg.content : "",
        });
        continue;
      }
      if (typeof msg.content === "string") {
        items.push({ role: msg.role, content: msg.content });
        continue;
      }
      if (msg.role === "assistant") {
        const text = msg.content
          .filter(
            (p): p is Extract<ContentPart, { type: "text" }> =>
              p.type === "text"
          )
          .map((p) => p.text)
          .join("");
        if (text) items.push({ role: "assistant", content: text });
        for (const part of msg.content) {
          if (part.type !== "tool_call") continue;
          items.push({
            type: "function_call",
            call_id: part.id,
            name: part.name,
            arguments: part.arguments,
          });
        }
        continue;
      }
      items.push({
        role: msg.role,
        content: msg.content
          .filter((p) => p.type === "text" || p.type === "image_url")
          .map((p) => {
            if (p.type === "image_url") {
              return {
                type: "input_image" as const,
                image_url: p.image_url.url,
                detail: "auto" as const,
              };
            }
            return { type: "input_text" as const, text: p.text };
          }),
      });
    }

    return items;
  }

  private toResponseTools(
    request: CompletionRequest
  ): OpenAI.Responses.Tool[] | undefined {
    const tools = (request.tools ?? []).map((t) => ({
      type: "function" as const,
      name: t.name,
      description: t.description,
      parameters: t.parameters as Record<string, unknown>,
      strict: false,
    }));
    return tools.length > 0 ? tools : undefined;
  }

  private fromResponse(
    response: OpenAI.Responses.Response
  ): CompletionResponse {
    const parts: ContentPart[] = [];

    for (const item of response.output ?? []) {
      this.collectOutputItem(item, parts);
    }

    const sawToolCall = parts.some((p) => p.type === "tool_call");
    let stopReason: StopReason = sawToolCall ? "tool_use" : "end_turn";
    if (
      !sawToolCall &&
      response.incomplete_details?.reason === "max_output_tokens"
    ) {
      stopReason = "max_tokens";
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
      stop_reason: stopReason,
      usage: response.usage
        ? {
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
            ...(response.usage.output_tokens_details?.reasoning_tokens != null
              ? {
                  reasoning_tokens:
                    response.usage.output_tokens_details.reasoning_tokens,
                }
              : {}),
          }
        : undefined,
    };
  }

  private collectOutputItem(
    item: ResponseOutputItem,
    parts: ContentPart[]
  ): void {
    if (item.type === "message") {
      for (const content of item.content) {
        if (content.type === "output_text" && content.text) {
          parts.push({ type: "text", text: content.text });
        }
      }
      return;
    }
    if (item.type === "function_call") {
      parts.push({
        type: "tool_call",
        id: item.call_id,
        name: item.name,
        arguments: item.arguments,
      });
    }
  }
}
