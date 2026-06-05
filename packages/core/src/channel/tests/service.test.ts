import { EventBus, PluginHost, RuntimeCapabilityRegistry } from "@open-vera/plugin-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChannelService } from "../service.js";
import type {
  ChannelAdapter,
  ChannelMessage,
  ChannelStatus,
  ConnectionState,
  HistoryOptions,
  MessageCallback,
  SendMessageOptions,
} from "../types.js";

const pluginFixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../plugin-runtime/src/tests/fixtures/basic-plugin",
);

function createMockAdapter(overrides?: Partial<ChannelAdapter>): ChannelAdapter {
  let state: ConnectionState = "disconnected";
  const messageCallbacks: MessageCallback[] = [];
  return {
    name: "mock-channel",
    channelType: "cli",
    get state() { return state; },
    connect: vi.fn(async () => { state = "connected"; }),
    disconnect: vi.fn(async () => { state = "disconnected"; }),
    getStatus: vi.fn((): ChannelStatus => ({
      state,
      changedAt: "2026-06-05T00:00:00.000Z",
      sentCount: 0,
      receivedCount: 0,
    })),
    sendMessage: vi.fn(async (options: SendMessageOptions): Promise<ChannelMessage> => ({
      id: "msg-1",
      channelType: "cli",
      senderId: "bot",
      content: options.content,
      attachments: [],
      timestamp: "2026-06-05T00:00:00.000Z",
    })),
    onMessage: vi.fn((callback: MessageCallback) => {
      messageCallbacks.push(callback);
      return () => {
        const idx = messageCallbacks.indexOf(callback);
        if (idx >= 0) messageCallbacks.splice(idx, 1);
      };
    }),
    getHistory: vi.fn(async (_options?: HistoryOptions): Promise<ChannelMessage[]> => []),
    ...overrides,
  };
}

function makeMessage(overrides?: Partial<ChannelMessage>): ChannelMessage {
  return {
    id: "incoming-1",
    channelType: "cli",
    senderId: "user",
    content: "incoming",
    attachments: [],
    timestamp: "2026-06-05T00:00:00.000Z",
    ...overrides,
  };
}

describe("ChannelService", () => {
  let eventBus: EventBus;
  let seen: string[];
  const roots: string[] = [];

  beforeEach(() => {
    eventBus = new EventBus();
    seen = [];
    for (const eventName of [
      "channel:adapter:load",
      "channel:connect",
      "channel:message:send",
      "channel:message:receive",
      "channel:error",
      "channel:disconnect",
      "channel:adapter:unload",
    ]) {
      eventBus.observe(eventName, (event) => {
        const instance = event.ctx.metadata?.["instanceName"] ?? (event.value as Record<string, unknown>)["instanceName"];
        seen.push(`${event.name}:${String(instance)}`);
      });
    }
  });

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("registers channel-adapter capabilities without exposing factories", () => {
    const capabilities = new RuntimeCapabilityRegistry();
    const service = new ChannelService({ eventBus, capabilities });

    service.registerCapability({
      id: "memory-channel",
      name: "Memory Channel",
      description: "In-memory test channel",
      channelType: "cli",
      version: "1.0.0",
      factory: async () => createMockAdapter(),
      ownerPluginId: "com.example.channel",
      source: "plugin:com.example.channel",
      metadata: { fixture: true },
    });

    expect(service.registry.hasPlugin("memory-channel")).toBe(true);
    expect(capabilities.listDescriptors()).toEqual([
      expect.objectContaining({
        id: "memory-channel",
        kind: "channel",
        name: "Memory Channel",
        metadata: expect.objectContaining({
          ownerPluginId: "com.example.channel",
          runtimeKind: "channel-adapter",
          channelType: "cli",
          fixture: true,
        }),
      }),
    ]);
    expect(JSON.stringify(capabilities.listDescriptors())).not.toContain("factory");
  });

  it("loads channel-adapter capabilities contributed by plugin runtime", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-channel-service-plugin-"));
    roots.push(root);
    const pluginHost = new PluginHost({ rootDir: root, eventBus });
    pluginHost.discover({ type: "local", path: pluginFixtureDir });
    pluginHost.enable("com.example.basic");
    await pluginHost.activate("com.example.basic");

    const service = new ChannelService({ eventBus });
    const capability = pluginHost.capabilities.get("fixture-channel");
    expect(capability).toBeDefined();
    service.registerRuntimeCapability(capability!);

    await service.loadAdapter("fixture-channel", "fixture-main");
    const sent = await service.sendMessage("fixture-main", { content: "from plugin channel" });

    expect(sent).toMatchObject({
      id: "fixture-message",
      channelType: "cli",
      senderId: "fixture",
      content: "from plugin channel",
    });
    expect(seen).toContain("channel:adapter:load:fixture-main");
    expect(seen).toContain("channel:message:send:fixture-main");
  });

  it("loads adapters through capabilities and emits channel lifecycle events", async () => {
    const adapter = createMockAdapter();
    const service = new ChannelService({ eventBus });
    service.registerCapability({
      id: "memory-channel",
      channelType: "cli",
      factory: async () => adapter,
    });

    const loaded = await service.loadAdapter("memory-channel", "main", { token: "secret" });
    expect(loaded).toBe(adapter);
    expect(service.gateway.getAdapter("main")).toBe(adapter);

    await service.connect("main");
    const sent = await service.sendMessage("main", { content: "hello" });
    await service.disconnect("main");
    const unloaded = await service.unloadAdapter("main");

    expect(sent.content).toBe("hello");
    expect(unloaded).toBe(adapter);
    expect(service.gateway.getAdapter("main")).toBeUndefined();
    expect(adapter.disconnect).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([
      "channel:adapter:load:main",
      "channel:connect:main",
      "channel:message:send:main",
      "channel:disconnect:main",
      "channel:disconnect:main",
      "channel:adapter:unload:main",
    ]);
  });

  it("bridges gateway receive events into EventBus", async () => {
    const service = new ChannelService({ eventBus });
    service.registerCapability({
      id: "memory-channel",
      channelType: "cli",
      factory: async () => createMockAdapter(),
    });
    await service.loadAdapter("memory-channel", "main");

    await service.gateway.dispatchMessage(makeMessage({ content: "from user" }), "main");

    expect(seen).toEqual([
      "channel:adapter:load:main",
      "channel:message:receive:main",
    ]);
  });

  it("emits channel:error when lifecycle operations fail", async () => {
    const service = new ChannelService({ eventBus });
    service.registerCapability({
      id: "broken-channel",
      channelType: "cli",
      factory: async () => createMockAdapter({
        connect: vi.fn(async () => {
          throw new Error("connect failed");
        }),
      }),
    });
    await service.loadAdapter("broken-channel", "main");

    await expect(service.connect("main")).rejects.toThrow("connect failed");

    expect(seen).toEqual([
      "channel:adapter:load:main",
      "channel:error:main",
    ]);
  });

  it("rejects loading disabled channel capabilities", async () => {
    const service = new ChannelService({ eventBus });
    service.registerCapability({
      id: "disabled-channel",
      channelType: "cli",
      status: "disabled",
      factory: async () => createMockAdapter(),
    });

    await expect(service.loadAdapter("disabled-channel", "main")).rejects.toThrow(
      "Channel capability disabled-channel is not available: disabled",
    );
  });
});
