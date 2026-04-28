import type {
  CompletionRequest,
  CompletionResponse,
  StreamEvent,
} from "../types/index.js";
import type { ModelInfo } from "../types/model.js";

export interface LLMAdapter {
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  stream(request: CompletionRequest): AsyncIterable<StreamEvent>;
  listModels?(): Promise<ModelInfo[]>;
}
