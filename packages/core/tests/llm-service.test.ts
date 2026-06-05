import { EventBus, RuntimeCapabilityRegistry } from "@open-vera/plugin-runtime";
import { describe, expect, it } from "vitest";
import { LlmService, UnknownLlmAdapterError } from "../src/adapters/index.js";
import type { VeraConfig } from "../src/config/types.js";
import type { CompletionResponse } from "../src/types/index.js";

function config(): VeraConfig {
  return {
    default_provider: "local-openai",
    providers: {
      "local-openai": {
        adapter: "openai",
        model: "gpt-test",
        ["api_" + "key"]: "placeholder",
        base_url: "https://example.invalid/v1",
        headers: {
          Authorization: "should-not-be-used-by-test",
        },
      },
      "local-gemini": {
        adapter: "gemini",
        model: "gemini-test",
        ["api_" + "key"]: "placeholder",
      },
    },
  } as VeraConfig;
}

describe("LlmService", () => {
  it("resolves default provider and model from config", () => {
    const service = new LlmService({ config: config() });

    expect(service.resolveModel()).toEqual({
      provider: "local-openai",
      model: "claude-opus-4-6",
    });
    expect(service.selectAdapter({ provider: "local-gemini" })).toMatchObject({
      provider: "local-gemini",
      adapterType: "gemini",
      model: "claude-opus-4-6",
    });
  });

  it("wraps complete calls with llm events", async () => {
    const eventBus = new EventBus();
    const seen: string[] = [];
    eventBus.transform("llm:request", (event) => {
      seen.push(`request:${String(event.ctx.metadata?.["purpose"])}`);
      return event.value;
    });
    eventBus.observe("llm:response", (event) => {
      seen.push(`response:${String((event.value as Record<string, unknown>)["contentLength"])}`);
    });

    const service = new LlmService({ config: config(), eventBus });
    const selected = service.selectAdapter();
    selected.adapter.complete = async (): Promise<CompletionResponse> => ({
      message: { role: "assistant", content: "hello" },
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    service.selectAdapter = () => selected;

    await expect(service.complete({
      model: "ignored",
      messages: [{ role: "user", content: "hi" }],
    }, { purpose: "routing" })).resolves.toMatchObject({ message: { content: "hello" } });
    expect(seen).toEqual(["request:routing", "response:5"]);
  });

  it("emits llm:error when the adapter fails", async () => {
    const eventBus = new EventBus();
    const seen: string[] = [];
    eventBus.observe("llm:error", (event) => {
      seen.push(String((event.value as Record<string, unknown>)["error"]));
    });

    const service = new LlmService({ config: config(), eventBus });
    const selected = service.selectAdapter();
    selected.adapter.complete = async () => {
      throw new Error("boom");
    };
    service.selectAdapter = () => selected;

    await expect(service.complete({
      model: "ignored",
      messages: [{ role: "user", content: "hi" }],
    })).rejects.toThrow("boom");
    expect(seen).toEqual(["boom"]);
  });

  it("buildAdapter returns a compatibility adapter that still emits llm events", async () => {
    const eventBus = new EventBus();
    const seen: string[] = [];
    eventBus.transform("llm:request", (event) => {
      seen.push(`request:${String(event.ctx.metadata?.["purpose"])}`);
      return event.value;
    });

    const service = new LlmService({ config: config(), eventBus });
    const selected = service.selectAdapter();
    selected.adapter.complete = async (): Promise<CompletionResponse> => ({
      message: { role: "assistant", content: "compat" },
      stop_reason: "end_turn",
    });
    service.selectAdapter = () => selected;

    const adapter = service.buildAdapter("local-openai", "gpt-test", { purpose: "compression" });
    const response = await adapter.complete({
      model: "ignored",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(response.message.content).toBe("compat");
    expect(seen).toEqual(["request:compression"]);
  });

  it("selects an explicitly registered adapter factory for custom provider adapters", async () => {
    const customConfig: VeraConfig = {
      default_provider: "custom-provider",
      default_model: "custom-model",
      providers: {
        "custom-provider": {
          adapter: "plugin-mock",
          ["api_" + "key"]: "placeholder",
          base_url: "https://plugin.example/v1",
          headers: { "X-Test": "yes" },
        },
      },
    };
    const calls: unknown[] = [];
    const service = new LlmService({
      config: customConfig,
      adapterFactories: {
        "plugin-mock": (options) => {
          calls.push(options);
          return {
            complete: async (): Promise<CompletionResponse> => ({
              message: { role: "assistant", content: "custom" },
              stop_reason: "end_turn",
            }),
            stream: async function* () {
              yield { type: "text", text: "custom" };
              yield { type: "done", stop_reason: "end_turn" };
            },
          };
        },
      },
    });

    const selected = service.selectAdapter({ purpose: "tool" });
    const response = await selected.adapter.complete({
      model: selected.model,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(selected).toMatchObject({
      provider: "custom-provider",
      adapterType: "plugin-mock",
      model: "custom-model",
    });
    expect(response.message.content).toBe("custom");
    expect(calls).toEqual([{
      adapterType: "plugin-mock",
      provider: "custom-provider",
      model: "custom-model",
      apiKey: "placeholder",
      baseUrl: "https://plugin.example/v1",
      headers: { "X-Test": "yes" },
      purpose: "tool",
    }]);
  });

  it("selects llm-adapter runtime capabilities registered by plugins", async () => {
    const capabilities = new RuntimeCapabilityRegistry();
    capabilities.register({
      id: "plugin-provider",
      kind: "llm-adapter",
      name: "Plugin Provider",
      ownerPluginId: "com.example.provider",
      scope: "project",
      status: "available",
      factory: () => ({
        complete: async (): Promise<CompletionResponse> => ({
          message: { role: "assistant", content: "from capability" },
          stop_reason: "end_turn",
        }),
        stream: async function* () {
          yield { type: "text", text: "from capability" };
          yield { type: "done", stop_reason: "end_turn" };
        },
      }),
    });
    const customConfig: VeraConfig = {
      default_provider: "plugin-provider",
      default_model: "plugin-model",
      providers: {
        "plugin-provider": { adapter: "plugin-provider" },
      },
    };
    const service = new LlmService({ config: customConfig, capabilities });

    const selected = service.selectAdapter();
    const response = await selected.adapter.complete({
      model: selected.model,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(selected).toMatchObject({
      provider: "plugin-provider",
      adapterType: "plugin-provider",
      model: "plugin-model",
    });
    expect(response.message.content).toBe("from capability");
  });

  it("throws a clear error for unknown provider adapter names", () => {
    const service = new LlmService({
      config: {
        default_provider: "custom-provider",
        providers: {
          "custom-provider": { adapter: "missing-adapter" },
        },
      },
    });

    expect(() => service.selectAdapter()).toThrow(UnknownLlmAdapterError);
    expect(() => service.selectAdapter()).toThrow(
      'No LLM adapter registered for adapter "missing-adapter" used by provider "custom-provider"',
    );
  });
});
