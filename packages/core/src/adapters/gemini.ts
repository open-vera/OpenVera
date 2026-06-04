import {
  GoogleGenerativeAI,
  type Part,
  type Content,
  type GenerateContentResponse,
} from "@google/generative-ai";
import type { LLMAdapter } from "./base.js";
import type {
  CompletionRequest,
  CompletionResponse,
  StreamEvent,
  Message,
  ContentPart,
} from "../types/index.js";
import type { ModelInfo } from "../types/model.js";
import { AdapterRequestError } from "../errors.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("adapter:gemini");

export class GeminiAdapter implements LLMAdapter {
  private genAI: GoogleGenerativeAI;
  private apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? "";
    this.genAI = new GoogleGenerativeAI(this.apiKey);
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const startMs = Date.now();
    try {
      const { chat, lastParts } = this.buildChat(request);
      const result = await chat.sendMessage(lastParts);
      log.debug("complete done", { model: request.model, duration_ms: Date.now() - startMs });
      return this.fromGeminiResponse(result.response);
    } catch (err) {
      log.warn("complete failed", { model: request.model, duration_ms: Date.now() - startMs, error: String(err) });
      throw err;
    }
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    const startMs = Date.now();
    const { chat, lastParts } = this.buildChat(request);
    const result = await chat.sendMessageStream(lastParts);

    const toolCalls: ContentPart[] = [];

    for await (const chunk of result.stream) {
      const candidate = chunk.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if (part.text) {
          yield { type: "text", text: part.text };
        } else if (part.functionCall) {
          toolCalls.push({
            type: "tool_call",
            id: part.functionCall.name,
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args),
          });
        }
      }
    }

    for (const tc of toolCalls) {
      if (tc.type === "tool_call") {
        yield {
          type: "tool_call",
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        };
      }
    }

    // Extract usage from the aggregated final response (available after stream ends).
    const finalResponse = await result.response;
    const usageMeta = finalResponse.usageMetadata;
    const usage = usageMeta
      ? {
          input_tokens: usageMeta.promptTokenCount ?? 0,
          output_tokens: usageMeta.candidatesTokenCount ?? 0,
        }
      : undefined;

    yield {
      type: "done",
      stop_reason: toolCalls.length > 0 ? "tool_use" : "end_turn",
      usage,
    };
    log.debug("stream done", { model: request.model, duration_ms: Date.now() - startMs, usage });
  }

  async listModels(): Promise<ModelInfo[]> {
    // @google/generative-ai SDK doesn't expose listModels; use REST directly
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${this.apiKey}&pageSize=100`
    );
    if (!res.ok) throw new AdapterRequestError("Gemini", res.status);
    const json = (await res.json()) as {
      models?: Array<{
        name: string;
        displayName?: string;
        inputTokenLimit?: number;
      }>;
    };
    return (json.models ?? []).map((m) => ({
      id: m.name.replace("models/", ""),
      display_name: m.displayName,
      context_window: m.inputTokenLimit,
    }));
  }

  private buildChat(request: CompletionRequest) {
    const model = this.genAI.getGenerativeModel({
      model: request.model,
      systemInstruction: request.system,
      tools:
        (request.tools ?? []).length > 0
          ? [
              {
                functionDeclarations: request.tools!.map((t) => ({
                  name: t.name,
                  description: t.description,
                  parameters: t.parameters as never,
                })),
              },
            ]
          : undefined,
    });

    const history = this.toGeminiHistory(request.messages);
    const lastMessage = history.pop();
    const chat = model.startChat({ history });
    return { chat, lastParts: lastMessage?.parts ?? [] };
  }

  private toGeminiHistory(messages: Message[]): Content[] {
    return messages
      .filter((m) => m.role !== "system")
      .map((msg): Content => {
        if (msg.role === "tool") {
          return {
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: msg.tool_call_id ?? "",
                  response: {
                    content: typeof msg.content === "string" ? msg.content : "",
                  },
                },
              },
            ],
          };
        }

        const role = msg.role === "assistant" ? "model" : "user";

        if (typeof msg.content === "string") {
          return { role, parts: [{ text: msg.content }] };
        }

        const parts: Part[] = msg.content.flatMap((part): Part[] => {
          if (part.type === "text") return [{ text: part.text }];
          if (part.type === "tool_call") {
            return [
              {
                functionCall: {
                  name: part.name,
                  args: JSON.parse(part.arguments),
                },
              },
            ];
          }
          if (part.type === "tool_result") {
            return [
              {
                functionResponse: {
                  name: part.tool_call_id,
                  response: { content: part.content },
                },
              },
            ];
          }
          return [];
        });

        return { role, parts };
      });
  }

  private fromGeminiResponse(
    response: GenerateContentResponse
  ): CompletionResponse {
    const candidate = response.candidates?.[0];
    const parts: ContentPart[] = [];

    for (const part of candidate?.content?.parts ?? []) {
      if (part.text) parts.push({ type: "text", text: part.text });
      else if (part.functionCall) {
        parts.push({
          type: "tool_call",
          id: part.functionCall.name,
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args),
        });
      }
    }

    const hasFunctionCall = parts.some((p) => p.type === "tool_call");
    const message: Message = {
      role: "assistant",
      content:
        parts.length === 1 && parts[0].type === "text"
          ? (parts[0] as { text: string }).text
          : parts,
    };

    return { message, stop_reason: hasFunctionCall ? "tool_use" : "end_turn" };
  }
}
