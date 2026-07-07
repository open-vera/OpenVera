import Anthropic from "@anthropic-ai/sdk";
import type { LLMAdapter } from "./base.js";
import type {
  CompletionRequest,
  CompletionResponse,
  StreamEvent,
  Message,
  ContentPart,
} from "../types/index.js";
import type { ModelInfo } from "../types/model.js";
import { createLogger } from "@open-vera/logger";

const log = createLogger("adapter:anthropic");
const MAX_CACHE_CONTROL_BLOCKS = 4;

function parseToolInput(argumentsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseDataImageUrl(url: string): { mediaType: string; data: string } | null {
  const match = url.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) return null;
  return { mediaType: match[1] ?? "image/png", data: match[2] ?? "" };
}

export class AnthropicAdapter implements LLMAdapter {
  private client: Anthropic;

  constructor(apiKey?: string, baseUrl?: string, headers?: Record<string, string>) {
    this.client = new Anthropic({
      apiKey,
      baseURL: baseUrl || undefined,
      defaultHeaders: headers,
    });
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const startMs = Date.now();
    try {
      const response = await this.client.messages.create({
        model: request.model,
        max_tokens: request.max_tokens ?? 8096,
        system: request.system
          ? [{ type: "text" as const, text: request.system, cache_control: { type: "ephemeral" as const } } as any]
          : undefined,
        messages: this.toAnthropicMessages(
          request.messages,
          request.system ? MAX_CACHE_CONTROL_BLOCKS - 1 : MAX_CACHE_CONTROL_BLOCKS,
        ),
        tools: this.toAnthropicTools(request),
      }, { signal: request.signal });
      const durationMs = Date.now() - startMs;
      log.debug("complete done", { model: request.model, duration_ms: durationMs, usage: response.usage });
      return this.fromAnthropicResponse(response);
    } catch (err) {
      log.warn("complete failed", { model: request.model, duration_ms: Date.now() - startMs, error: String(err) });
      throw err;
    }
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    const startMs = Date.now();
    // 累积 tool call 参数（Anthropic 流式分块下发 JSON）
    const toolCalls: Record<
      number,
      { id: string; name: string; arguments: string }
    > = {};

    const apiStream = this.client.messages.stream({
      model: request.model,
      max_tokens: request.max_tokens ?? 8096,
      system: request.system,
      messages: this.toAnthropicMessages(
        request.messages,
        request.system ? MAX_CACHE_CONTROL_BLOCKS - 1 : MAX_CACHE_CONTROL_BLOCKS,
      ),
      tools: this.toAnthropicTools(request),
      ...(request.thinking_budget
        ? { thinking: { type: "enabled" as const, budget_tokens: request.thinking_budget } }
        : {}),
    }, { signal: request.signal });

    try {
      for await (const event of apiStream) {
        if (
          event.type === "content_block_start" &&
          event.content_block.type === "tool_use"
        ) {
          toolCalls[event.index] = {
            id: event.content_block.id,
            name: event.content_block.name,
            arguments: "",
          };
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "thinking_delta") {
            yield { type: "thinking", text: event.delta.thinking };
          } else if (event.delta.type === "text_delta") {
            yield { type: "text", text: event.delta.text };
          } else if (event.delta.type === "input_json_delta") {
            const tc = toolCalls[event.index];
            if (tc) tc.arguments += event.delta.partial_json;
          }
        }
      }
    } catch (err) {
      // Surface stream errors cleanly; the agent loop's reactive-compact
      // catches prompt-too-long; other errors terminate the turn.
      throw err;
    }

    // 发出完整 tool_call 事件
    for (const tc of Object.values(toolCalls)) {
      yield {
        type: "tool_call",
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      };
    }

    const final = await apiStream.finalMessage();
    const durationMs = Date.now() - startMs;
    log.debug("stream done", { model: request.model, duration_ms: durationMs, usage: final.usage });
    yield {
      type: "done",
      stop_reason: final.stop_reason === "tool_use" ? "tool_use" : "end_turn",
      usage: {
        input_tokens: final.usage.input_tokens,
        output_tokens: final.usage.output_tokens,
        cache_creation_input_tokens: final.usage.cache_creation_input_tokens ?? undefined,
        cache_read_input_tokens: final.usage.cache_read_input_tokens ?? undefined,
      },
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const page = await this.client.models.list();
    return page.data.map((m) => ({
      id: m.id,
      display_name: m.display_name,
      created: Math.floor(new Date(m.created_at).getTime() / 1000),
    }));
  }

  private toAnthropicMessages(
    messages: Message[],
    maxCacheControlBlocks = MAX_CACHE_CONTROL_BLOCKS,
  ): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];
    const cacheableMessageIndexes = messages
      .map((msg, index) => ({ msg, index }))
      .filter(({ msg }) => msg.role !== "system")
      .filter(({ index }) => {
        const msg = messages[index];
        return !(msg?.role === "user" && index === messages.length - 1);
      })
      .slice(-Math.max(0, maxCacheControlBlocks))
      .map(({ index }) => index);
    const cacheableIndexes = new Set(cacheableMessageIndexes);

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === "system") continue;

      // Anthropic allows at most 4 cache_control blocks per request.
      // Keep caching on the most recent stable context only; the final
      // user message varies every turn and must remain uncached.
      const enableCache = cacheableIndexes.has(i);

      if (msg.role === "tool") {
        result.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: msg.tool_call_id!,
              content: typeof msg.content === "string" ? msg.content : "",
              ...(enableCache ? { cache_control: { type: "ephemeral" as const } } as any : {}),
            },
          ],
        });
      } else if (typeof msg.content === "string") {
        const block: any = { type: "text", text: msg.content };
        if (enableCache) block.cache_control = { type: "ephemeral" };
        result.push({
          role: msg.role as "user" | "assistant",
          content: [block],
        });
      } else {
        const content: any[] = msg.content.flatMap(
          (part): Anthropic.ContentBlockParam[] => {
            if (part.type === "text")
              return [{ type: "text", text: part.text }];
            if (part.type === "image_url") {
              const image = parseDataImageUrl(part.image_url.url);
              if (!image) return [];
              return [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: image.mediaType,
                    data: image.data,
                  },
                } as Anthropic.ContentBlockParam,
              ];
            }
            if (part.type === "tool_call") {
              return [
                {
                  type: "tool_use",
                  id: part.id,
                  name: part.name,
                  input: parseToolInput(part.arguments),
                },
              ];
            }
            return [];
          }
        );
        // Add cache_control to the last content block of cacheable messages
        if (enableCache && content.length > 0) {
          content[content.length - 1].cache_control = { type: "ephemeral" };
        }
        result.push({ role: msg.role as "user" | "assistant", content });
      }
    }
    return result;
  }

  private toAnthropicTools(
    request: CompletionRequest
  ): Anthropic.Tool[] | undefined {
    const tools = (request.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool["input_schema"],
    }));
    return tools.length > 0 ? tools : undefined;
  }

  private fromAnthropicResponse(
    response: Anthropic.Message
  ): CompletionResponse {
    const parts: ContentPart[] = response.content.flatMap(
      (block): ContentPart[] => {
        if (block.type === "text") return [{ type: "text", text: block.text }];
        if (block.type === "thinking") return [{ type: "thinking", thinking: block.thinking }];
        if (block.type === "tool_use") {
          return [
            {
              type: "tool_call",
              id: block.id,
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          ];
        }
        return [];
      }
    );
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
        response.stop_reason === "tool_use" ? "tool_use" : "end_turn",
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? undefined,
        cache_read_input_tokens: response.usage.cache_read_input_tokens ?? undefined,
      },
    };
  }
}
