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

export class AnthropicAdapter implements LLMAdapter {
  private client: Anthropic;

  constructor(apiKey?: string, baseUrl?: string) {
    this.client = new Anthropic({
      apiKey,
      baseURL: baseUrl || undefined,
    });
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const response = await this.client.messages.create({
      model: request.model,
      max_tokens: request.max_tokens ?? 8096,
      system: request.system,
      messages: this.toAnthropicMessages(request.messages),
      tools: this.toAnthropicTools(request),
    }, { signal: request.signal });
    return this.fromAnthropicResponse(response);
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    // 累积 tool call 参数（Anthropic 流式分块下发 JSON）
    const toolCalls: Record<
      number,
      { id: string; name: string; arguments: string }
    > = {};

    const apiStream = this.client.messages.stream({
      model: request.model,
      max_tokens: request.max_tokens ?? 8096,
      system: request.system,
      messages: this.toAnthropicMessages(request.messages),
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

  private toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
    return messages
      .filter((m) => m.role !== "system")
      .map((msg): Anthropic.MessageParam => {
        if (msg.role === "tool") {
          return {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: msg.tool_call_id!,
                content: typeof msg.content === "string" ? msg.content : "",
              },
            ],
          };
        }
        if (typeof msg.content === "string") {
          return {
            role: msg.role as "user" | "assistant",
            content: msg.content,
          };
        }
        const content: Anthropic.ContentBlockParam[] = msg.content.flatMap(
          (part): Anthropic.ContentBlockParam[] => {
            if (part.type === "text")
              return [{ type: "text", text: part.text }];
            if (part.type === "tool_call") {
              return [
                {
                  type: "tool_use",
                  id: part.id,
                  name: part.name,
                  input: JSON.parse(part.arguments),
                },
              ];
            }
            return [];
          }
        );
        return { role: msg.role as "user" | "assistant", content };
      });
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
