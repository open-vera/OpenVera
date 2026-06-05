import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ChannelPluginRegistry,
  PluginAlreadyRegisteredError,
  PluginNotFoundError,
  AdapterAlreadyLoadedError,
  AdapterNotLoadedError,
} from "../plugin-registry.js";
import type {
  ChannelPlugin,
  ChannelPluginMeta,
} from "../plugin-registry.js";
import type {
  ChannelAdapter,
  ConnectionState,
  ChannelStatus,
  MessageCallback,
  SendMessageOptions,
  HistoryOptions,
  ChannelMessage,
} from "../types.js";

function createMockAdapter(overrides?: Partial<ChannelAdapter>): ChannelAdapter {
  let state: ConnectionState = "disconnected";
  return {
    name: "mock",
    channelType: "cli",
    get state() { return state; },
    connect: vi.fn(async () => { state = "connected"; }),
    disconnect: vi.fn(async () => { state = "disconnected"; }),
    getStatus: vi.fn((): ChannelStatus => ({
      state,
      changedAt: new Date().toISOString(),
      sentCount: 0,
      receivedCount: 0,
    })),
    sendMessage: vi.fn(async (options: SendMessageOptions): Promise<ChannelMessage> => ({
      id: "msg-1",
      channelType: "cli",
      senderId: "bot",
      content: options.content,
      attachments: [],
      timestamp: new Date().toISOString(),
    })),
    onMessage: vi.fn((_callback: MessageCallback) => () => {}),
    getHistory: vi.fn(async (_options?: HistoryOptions): Promise<ChannelMessage[]> => []),
    ...overrides,
  };
}

function createPlugin(overrides?: Partial<ChannelPluginMeta>): ChannelPlugin {
  const meta: ChannelPluginMeta = {
    name: "test-plugin",
    description: "A test plugin",
    channelType: "cli",
    version: "1.0.0",
    ...overrides,
  };
  return {
    meta,
    factory: vi.fn(async () => createMockAdapter({ name: meta.name, channelType: meta.channelType })),
  };
}

describe("ChannelPluginRegistry", () => {
  let registry: ChannelPluginRegistry;

  beforeEach(() => {
    registry = new ChannelPluginRegistry();
  });

  // ── Plugin Registration ──────────────────────────────────────────────────

  describe("registerPlugin", () => {
    it("should register a plugin", () => {
      const plugin = createPlugin();
      registry.registerPlugin(plugin);
      expect(registry.hasPlugin("test-plugin")).toBe(true);
    });

    it("should throw PluginAlreadyRegisteredError for duplicate name", () => {
      const plugin = createPlugin();
      registry.registerPlugin(plugin);
      expect(() => registry.registerPlugin(plugin)).toThrow(PluginAlreadyRegisteredError);
      expect(() => registry.registerPlugin(plugin)).toThrow("already registered");
    });

    it("should support registering multiple distinct plugins", () => {
      registry.registerPlugin(createPlugin({ name: "cli-plugin", channelType: "cli" }));
      registry.registerPlugin(createPlugin({ name: "api-plugin", channelType: "api" }));
      registry.registerPlugin(createPlugin({ name: "webhook-plugin", channelType: "webhook" }));
      expect(registry.pluginCount).toBe(3);
    });
  });

  describe("unregisterPlugin", () => {
    it("should remove a registered plugin", async () => {
      const plugin = createPlugin();
      registry.registerPlugin(plugin);
      await expect(registry.unregisterPlugin("test-plugin")).resolves.toBe(0);
      expect(registry.hasPlugin("test-plugin")).toBe(false);
    });

    it("should return 0 for non-existent plugin", async () => {
      await expect(registry.unregisterPlugin("nonexistent")).resolves.toBe(0);
    });

    it("should unload adapters created by the plugin", async () => {
      const plugin = createPlugin();
      registry.registerPlugin(plugin);
      await registry.loadAdapter("test-plugin", "instance-1");
      await registry.loadAdapter("test-plugin", "instance-2");
      expect(registry.adapterCount).toBe(2);

      const unloaded = await registry.unregisterPlugin("test-plugin");
      expect(unloaded).toBe(2);
      expect(registry.adapterCount).toBe(0);
      expect(registry.hasPlugin("test-plugin")).toBe(false);
    });
  });

  describe("hasPlugin", () => {
    it("should return true for registered plugin", () => {
      registry.registerPlugin(createPlugin());
      expect(registry.hasPlugin("test-plugin")).toBe(true);
    });

    it("should return false for unregistered plugin", () => {
      expect(registry.hasPlugin("nonexistent")).toBe(false);
    });
  });

  describe("getPlugin", () => {
    it("should return the plugin if registered", () => {
      const plugin = createPlugin({ name: "my-plugin", version: "2.0.0" });
      registry.registerPlugin(plugin);
      const result = registry.getPlugin("my-plugin");
      expect(result?.meta.version).toBe("2.0.0");
    });

    it("should return undefined for non-existent plugin", () => {
      expect(registry.getPlugin("nonexistent")).toBeUndefined();
    });
  });

  describe("listPlugins", () => {
    it("should return empty array when no plugins registered", () => {
      expect(registry.listPlugins()).toEqual([]);
    });

    it("should return all registered plugin metadata", () => {
      registry.registerPlugin(createPlugin({ name: "p1", channelType: "cli" }));
      registry.registerPlugin(createPlugin({ name: "p2", channelType: "api" }));
      const list = registry.listPlugins();
      expect(list).toHaveLength(2);
      expect(list.map((p) => p.name)).toEqual(["p1", "p2"]);
    });
  });

  // ── Adapter Loading ──────────────────────────────────────────────────────

  describe("loadAdapter", () => {
    it("should create and load an adapter from plugin factory", async () => {
      const plugin = createPlugin();
      registry.registerPlugin(plugin);
      const adapter = await registry.loadAdapter("test-plugin", "my-adapter", { token: "abc" });

      expect(adapter).toBeDefined();
      expect(plugin.factory).toHaveBeenCalledWith({ token: "abc" });
      expect(registry.adapterCount).toBe(1);
    });

    it("should throw PluginNotFoundError for unregistered plugin", async () => {
      await expect(registry.loadAdapter("nonexistent", "inst")).rejects.toThrow(PluginNotFoundError);
      await expect(registry.loadAdapter("nonexistent", "inst")).rejects.toThrow("not found");
    });

    it("should throw AdapterAlreadyLoadedError for duplicate instance name", async () => {
      registry.registerPlugin(createPlugin());
      await registry.loadAdapter("test-plugin", "inst-1");
      await expect(registry.loadAdapter("test-plugin", "inst-1")).rejects.toThrow(AdapterAlreadyLoadedError);
      await expect(registry.loadAdapter("test-plugin", "inst-1")).rejects.toThrow("already loaded");
    });

    it("should support loading from different plugins with unique instance names", async () => {
      registry.registerPlugin(createPlugin({ name: "cli-p", channelType: "cli" }));
      registry.registerPlugin(createPlugin({ name: "api-p", channelType: "api" }));

      await registry.loadAdapter("cli-p", "cli-main");
      await registry.loadAdapter("api-p", "api-main");

      expect(registry.adapterCount).toBe(2);
    });

    it("should allow same plugin to create multiple instances", async () => {
      registry.registerPlugin(createPlugin());
      await registry.loadAdapter("test-plugin", "inst-1");
      await registry.loadAdapter("test-plugin", "inst-2");
      expect(registry.adapterCount).toBe(2);
    });

    it("should use empty config by default", async () => {
      const plugin = createPlugin();
      registry.registerPlugin(plugin);
      await registry.loadAdapter("test-plugin", "inst");
      expect(plugin.factory).toHaveBeenCalledWith({});
    });
  });

  describe("unloadAdapter", () => {
    it("should unload a loaded adapter", async () => {
      registry.registerPlugin(createPlugin());
      await registry.loadAdapter("test-plugin", "inst");

      const removed = await registry.unloadAdapter("inst");
      expect(removed).toBeDefined();
      expect(registry.adapterCount).toBe(0);
    });

    it("should return undefined for non-existent instance", async () => {
      const result = await registry.unloadAdapter("nonexistent");
      expect(result).toBeUndefined();
    });

    it("should disconnect adapter before unloading if connected", async () => {
      const adapter = createMockAdapter();
      const plugin: ChannelPlugin = {
        meta: { name: "test-plugin", description: "test", channelType: "cli", version: "1.0.0" },
        factory: async () => adapter,
      };
      registry.registerPlugin(plugin);
      const loaded = await registry.loadAdapter("test-plugin", "inst");
      await loaded.connect();
      expect(adapter.state).toBe("connected");

      await registry.unloadAdapter("inst");
      expect(adapter.disconnect).toHaveBeenCalled();
    });

    it("should call disconnect even if adapter is not connected so resources are released", async () => {
      const adapter = createMockAdapter();
      const plugin: ChannelPlugin = {
        meta: { name: "test-plugin", description: "test", channelType: "cli", version: "1.0.0" },
        factory: async () => adapter,
      };
      registry.registerPlugin(plugin);
      await registry.loadAdapter("test-plugin", "inst");
      // Adapter starts disconnected
      await registry.unloadAdapter("inst");
      expect(adapter.disconnect).toHaveBeenCalled();
    });
  });

  describe("getLoadedAdapter", () => {
    it("should return loaded adapter entry", async () => {
      registry.registerPlugin(createPlugin());
      await registry.loadAdapter("test-plugin", "inst", { key: "val" });

      const entry = registry.getLoadedAdapter("inst");
      expect(entry).toBeDefined();
      expect(entry?.pluginName).toBe("test-plugin");
      expect(entry?.config).toEqual({ key: "val" });
      expect(entry?.loadedAt).toBeTruthy();
    });

    it("should return undefined for non-existent instance", () => {
      expect(registry.getLoadedAdapter("nonexistent")).toBeUndefined();
    });
  });

  describe("listLoadedAdapters", () => {
    it("should return empty array when no adapters loaded", () => {
      expect(registry.listLoadedAdapters()).toEqual([]);
    });

    it("should list all loaded adapters with instance names", async () => {
      registry.registerPlugin(createPlugin({ name: "p1" }));
      registry.registerPlugin(createPlugin({ name: "p2" }));
      await registry.loadAdapter("p1", "inst-1");
      await registry.loadAdapter("p2", "inst-2");

      const list = registry.listLoadedAdapters();
      expect(list).toHaveLength(2);
      expect(list[0].instanceName).toBe("inst-1");
      expect(list[0].pluginName).toBe("p1");
      expect(list[1].instanceName).toBe("inst-2");
      expect(list[1].pluginName).toBe("p2");
    });
  });

  // ── Batch Operations ─────────────────────────────────────────────────────

  describe("loadBatch", () => {
    it("should load multiple adapter instances from one plugin", async () => {
      registry.registerPlugin(createPlugin());
      const results = await registry.loadBatch("test-plugin", [
        { instanceName: "a1", config: { region: "us" } },
        { instanceName: "a2", config: { region: "eu" } },
        { instanceName: "a3" },
      ]);

      expect(results.size).toBe(3);
      expect(results.has("a1")).toBe(true);
      expect(results.has("a2")).toBe(true);
      expect(results.has("a3")).toBe(true);
      expect(registry.adapterCount).toBe(3);
    });

    it("should throw if any instance name conflicts", async () => {
      registry.registerPlugin(createPlugin());
      await registry.loadAdapter("test-plugin", "existing");

      await expect(
        registry.loadBatch("test-plugin", [
          { instanceName: "new-1" },
          { instanceName: "existing" },
        ]),
      ).rejects.toThrow(AdapterAlreadyLoadedError);
    });
  });

  describe("unloadAllByPlugin", () => {
    it("should unload all adapters from a specific plugin", async () => {
      registry.registerPlugin(createPlugin({ name: "p1" }));
      registry.registerPlugin(createPlugin({ name: "p2" }));
      await registry.loadAdapter("p1", "p1-inst-1");
      await registry.loadAdapter("p1", "p1-inst-2");
      await registry.loadAdapter("p2", "p2-inst-1");

      const count = await registry.unloadAllByPlugin("p1");
      expect(count).toBe(2);
      expect(registry.adapterCount).toBe(1);
      expect(registry.getLoadedAdapter("p2-inst-1")).toBeDefined();
    });

    it("should return 0 if no adapters from that plugin", async () => {
      registry.registerPlugin(createPlugin({ name: "p1" }));
      await expect(registry.unloadAllByPlugin("p1")).resolves.toBe(0);
    });

    it("should await disconnect before removing plugin adapters", async () => {
      const events: string[] = [];
      const adapter = createMockAdapter({
        disconnect: vi.fn(async () => {
          events.push("disconnect:start");
          await new Promise((resolve) => setTimeout(resolve, 1));
          events.push("disconnect:end");
        }),
      });
      registry.registerPlugin({
        meta: { name: "p1", description: "test", channelType: "cli", version: "1.0.0" },
        factory: async () => adapter,
      });
      await registry.loadAdapter("p1", "p1-inst");

      const count = await registry.unloadAllByPlugin("p1");

      expect(count).toBe(1);
      expect(events).toEqual(["disconnect:start", "disconnect:end"]);
      expect(registry.adapterCount).toBe(0);
    });
  });

  describe("unloadAll", () => {
    it("should unload all adapters and disconnect connected ones", async () => {
      const adapter1 = createMockAdapter();
      const adapter2 = createMockAdapter();
      const plugin1: ChannelPlugin = {
        meta: { name: "p1", description: "test", channelType: "cli", version: "1.0.0" },
        factory: async () => adapter1,
      };
      const plugin2: ChannelPlugin = {
        meta: { name: "p2", description: "test", channelType: "api", version: "1.0.0" },
        factory: async () => adapter2,
      };
      registry.registerPlugin(plugin1);
      registry.registerPlugin(plugin2);

      const loaded1 = await registry.loadAdapter("p1", "a1");
      await registry.loadAdapter("p2", "a2");
      await loaded1.connect();
      // adapter2 stays disconnected

      const count = await registry.unloadAll();
      expect(count).toBe(2);
      expect(registry.adapterCount).toBe(0);
      expect(adapter1.disconnect).toHaveBeenCalled();
      expect(adapter2.disconnect).toHaveBeenCalled();
    });

    it("should return 0 when no adapters loaded", async () => {
      expect(await registry.unloadAll()).toBe(0);
    });
  });

  // ── Introspection ────────────────────────────────────────────────────────

  describe("pluginCount", () => {
    it("should be 0 initially", () => {
      expect(registry.pluginCount).toBe(0);
    });

    it("should reflect registered plugins", () => {
      registry.registerPlugin(createPlugin({ name: "p1" }));
      registry.registerPlugin(createPlugin({ name: "p2" }));
      expect(registry.pluginCount).toBe(2);
    });
  });

  describe("adapterCount", () => {
    it("should be 0 initially", () => {
      expect(registry.adapterCount).toBe(0);
    });

    it("should reflect loaded adapters", async () => {
      registry.registerPlugin(createPlugin());
      await registry.loadAdapter("test-plugin", "a1");
      await registry.loadAdapter("test-plugin", "a2");
      expect(registry.adapterCount).toBe(2);
    });
  });

  describe("findByChannelType", () => {
    it("should return plugins matching the channel type", () => {
      registry.registerPlugin(createPlugin({ name: "cli1", channelType: "cli" }));
      registry.registerPlugin(createPlugin({ name: "cli2", channelType: "cli" }));
      registry.registerPlugin(createPlugin({ name: "api1", channelType: "api" }));

      const cliPlugins = registry.findByChannelType("cli");
      expect(cliPlugins).toHaveLength(2);
      expect(cliPlugins.map((p) => p.name)).toEqual(["cli1", "cli2"]);
    });

    it("should return empty array when no plugins match", () => {
      registry.registerPlugin(createPlugin({ name: "cli1", channelType: "cli" }));
      expect(registry.findByChannelType("telegram")).toEqual([]);
    });
  });

  // ── Error Classes ────────────────────────────────────────────────────────

  describe("error classes", () => {
    it("PluginAlreadyRegisteredError should have correct code", () => {
      const err = new PluginAlreadyRegisteredError("test");
      expect(err.code).toBe("PLUGIN_ALREADY_REGISTERED");
      expect(err.name).toBe("PluginAlreadyRegisteredError");
    });

    it("PluginNotFoundError should have correct code", () => {
      const err = new PluginNotFoundError("test");
      expect(err.code).toBe("PLUGIN_NOT_FOUND");
      expect(err.name).toBe("PluginNotFoundError");
    });

    it("AdapterAlreadyLoadedError should have correct code", () => {
      const err = new AdapterAlreadyLoadedError("test");
      expect(err.code).toBe("ADAPTER_ALREADY_LOADED");
      expect(err.name).toBe("AdapterAlreadyLoadedError");
    });

    it("AdapterNotLoadedError should have correct code", () => {
      const err = new AdapterNotLoadedError("test");
      expect(err.code).toBe("ADAPTER_NOT_LOADED");
      expect(err.name).toBe("AdapterNotLoadedError");
    });
  });
});
