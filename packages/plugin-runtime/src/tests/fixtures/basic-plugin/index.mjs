export default {
  async activate(ctx) {
    ctx.provide.tool({
      name: "fixture_echo",
      description: "Fixture Echo",
      parameters: { type: "object", properties: { text: { type: "string" } } },
      execute: async (args) => ({ ok: true, content: String(args?.text ?? "") }),
      metadata: { fixture: true },
      actions: ["view", "test"]
    });
    ctx.provide.llmAdapter("fixture-llm", () => ({
      complete: async () => ({
        message: { role: "assistant", content: "fixture" },
        stop_reason: "end_turn"
      })
    }), {
      displayName: "Fixture LLM",
      supportedPurposes: ["chat", "tool"],
      supportedModalities: ["text"]
    });
    ctx.provide.modelProvider("fixture-provider", {}, {
      displayName: "Fixture Provider",
      models: ["fixture-small"],
      defaultModel: "fixture-small"
    });
    ctx.provide.channelAdapter("fixture-channel", () => ({
      name: "fixture-channel-adapter",
      channelType: "cli",
      state: "disconnected",
      connect: async () => {},
      disconnect: async () => {},
      getStatus: () => ({
        state: "disconnected",
        changedAt: new Date(0).toISOString(),
        sentCount: 0,
        receivedCount: 0
      }),
      sendMessage: async (options) => ({
        id: "fixture-message",
        channelType: "cli",
        senderId: "fixture",
        content: String(options.content ?? ""),
        attachments: [],
        timestamp: new Date(0).toISOString()
      }),
      onMessage: () => () => {},
      getHistory: async () => []
    }), {
      displayName: "Fixture Channel",
      channelType: "cli",
      description: "Fixture channel adapter",
      version: "1.0.0"
    });
    ctx.provide.promptBlock({
      id: "fixture-prompt-block",
      content: "Fixture prompt contribution",
      priority: 20
    });
    ctx.provide.contextProvider({
      id: "fixture-context-provider",
      content: "Fixture context contribution",
      priority: 10,
      tokenEstimate: 4
    });

    ctx.hooks.transform("tool:after:fixture_echo", async (event) => ({
      ...event.value,
      transformedBy: ctx.pluginId
    }));

    ctx.disposables.add(() => {
      globalThis.__veraFixtureDisposed = (globalThis.__veraFixtureDisposed ?? 0) + 1;
    });
  },

  async deactivate(ctx) {
    ctx.logger.info("fixture deactivated");
  }
};
