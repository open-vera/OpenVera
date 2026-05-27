import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChannelGateway } from "../gateway.js";
import type {
  ChannelAdapter,
  ChannelMessage,
  ChannelStatus,
  ConnectionState,
  HistoryOptions,
  MessageCallback,
  SendMessageOptions,
} from "../types.js";

function createMockAdapter(overrides?: Partial<ChannelAdapter>): ChannelAdapter {
  let state: ConnectionState = "disconnected";
  const messageCallbacks: MessageCallback[] = [];
  return {
    name: "test-adapter",
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
      attachments: options.attachments ?? [],
      timestamp: new Date().toISOString(),
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
    id: "msg-1",
    channelType: "cli",
    senderId: "user-1",
    content: "hello",
    attachments: [],
    timestamp: "2026-05-27T12:00:00Z",
    ...overrides,
  };
}

describe("ChannelGateway", () => {
  let gateway: ChannelGateway;

  beforeEach(() => {
    gateway = new ChannelGateway();
  });

  // ── Config ──────────────────────────────────────────────────────────────

  describe("config", () => {
    it("should use default config when none provided", () => {
      expect(gateway.config.maxConnections).toBe(10);
      expect(gateway.config.defaultTimeoutMs).toBe(30_000);
      expect(gateway.config.autoReconnect).toBe(false);
      expect(gateway.config.reconnectIntervalMs).toBe(5_000);
      expect(gateway.config.maxReconnectAttempts).toBe(3);
    });

    it("should merge custom config with defaults", () => {
      const gw = new ChannelGateway({ maxConnections: 5, autoReconnect: true });
      expect(gw.config.maxConnections).toBe(5);
      expect(gw.config.autoReconnect).toBe(true);
      expect(gw.config.defaultTimeoutMs).toBe(30_000);
    });
  });

  // ── Adapter Management ──────────────────────────────────────────────────

  describe("addAdapter", () => {
    it("should register an adapter", () => {
      const adapter = createMockAdapter();
      gateway.addAdapter("cli", adapter);
      expect(gateway.getAdapter("cli")).toBe(adapter);
    });

    it("should throw if adapter name already exists", () => {
      const adapter = createMockAdapter();
      gateway.addAdapter("cli", adapter);
      expect(() => gateway.addAdapter("cli", adapter)).toThrow("already registered");
    });

    it("should throw if max connections reached", () => {
      const gw = new ChannelGateway({ maxConnections: 1 });
      gw.addAdapter("cli", createMockAdapter());
      expect(() => gw.addAdapter("api", createMockAdapter())).toThrow("Maximum connections");
    });

    it("should wire up message routing from adapter", () => {
      const adapter = createMockAdapter();
      gateway.addAdapter("cli", adapter);
      expect(adapter.onMessage).toHaveBeenCalled();
    });
  });

  describe("removeAdapter", () => {
    it("should remove a registered adapter", () => {
      const adapter = createMockAdapter();
      gateway.addAdapter("cli", adapter);
      expect(gateway.removeAdapter("cli")).toBe(true);
      expect(gateway.getAdapter("cli")).toBeUndefined();
    });

    it("should return false for non-existent adapter", () => {
      expect(gateway.removeAdapter("nonexistent")).toBe(false);
    });

    it("should clean up sessions bound to removed channel", () => {
      const adapter = createMockAdapter();
      gateway.addAdapter("cli", adapter);
      gateway.bindSession("cli", "session-1");
      gateway.removeAdapter("cli");
      expect(gateway.getSession("session-1")).toBeUndefined();
    });

    it("should unsubscribe message handler", () => {
      const unsub = vi.fn();
      const adapter = createMockAdapter({ onMessage: vi.fn(() => unsub) });
      gateway.addAdapter("cli", adapter);
      gateway.removeAdapter("cli");
      expect(unsub).toHaveBeenCalled();
    });
  });

  describe("listAdapters", () => {
    it("should list all registered adapters with state", () => {
      gateway.addAdapter("cli", createMockAdapter());
      gateway.addAdapter("api", createMockAdapter());
      const list = gateway.listAdapters();
      expect(list).toHaveLength(2);
      expect(list[0]).toEqual({ name: "cli", state: "disconnected" });
      expect(list[1]).toEqual({ name: "api", state: "disconnected" });
    });

    it("should return empty array when no adapters", () => {
      expect(gateway.listAdapters()).toEqual([]);
    });
  });

  // ── Connection Lifecycle ────────────────────────────────────────────────

  describe("connect", () => {
    it("should call adapter.connect()", async () => {
      const adapter = createMockAdapter();
      gateway.addAdapter("cli", adapter);
      await gateway.connect("cli");
      expect(adapter.connect).toHaveBeenCalled();
    });

    it("should emit channel_connected event", async () => {
      const handler = vi.fn();
      gateway.onEvent(handler);
      gateway.addAdapter("cli", createMockAdapter());
      await gateway.connect("cli");
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: "channel_connected", channelName: "cli" }));
    });

    it("should throw ChannelNotFoundError for unknown channel", async () => {
      await expect(gateway.connect("nonexistent")).rejects.toThrow("Channel not found");
    });
  });

  describe("disconnect", () => {
    it("should call adapter.disconnect()", async () => {
      const adapter = createMockAdapter();
      gateway.addAdapter("cli", adapter);
      await gateway.disconnect("cli");
      expect(adapter.disconnect).toHaveBeenCalled();
    });

    it("should emit channel_disconnected event", async () => {
      const handler = vi.fn();
      gateway.onEvent(handler);
      gateway.addAdapter("cli", createMockAdapter());
      await gateway.disconnect("cli");
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: "channel_disconnected", channelName: "cli" }));
    });
  });

  describe("connectAll", () => {
    it("should connect all adapters", async () => {
      const cli = createMockAdapter();
      const api = createMockAdapter();
      gateway.addAdapter("cli", cli);
      gateway.addAdapter("api", api);
      await gateway.connectAll();
      expect(cli.connect).toHaveBeenCalled();
      expect(api.connect).toHaveBeenCalled();
    });

    it("should return settled results including rejections", async () => {
      const failing = createMockAdapter({ connect: vi.fn().mockRejectedValue(new Error("fail")) });
      gateway.addAdapter("fail", failing);
      const results = await gateway.connectAll();
      expect(results[0].status).toBe("rejected");
    });
  });

  describe("disconnectAll", () => {
    it("should disconnect all adapters even if some fail", async () => {
      const cli = createMockAdapter();
      const failing = createMockAdapter({ disconnect: vi.fn().mockRejectedValue(new Error("fail")) });
      gateway.addAdapter("cli", cli);
      gateway.addAdapter("fail", failing);
      await gateway.disconnectAll();
      expect(cli.disconnect).toHaveBeenCalled();
      expect(failing.disconnect).toHaveBeenCalled();
    });
  });

  // ── Messaging ───────────────────────────────────────────────────────────

  describe("sendMessage", () => {
    it("should delegate to adapter.sendMessage()", async () => {
      const adapter = createMockAdapter();
      gateway.addAdapter("cli", adapter);
      const result = await gateway.sendMessage("cli", { content: "hello" });
      expect(adapter.sendMessage).toHaveBeenCalledWith({ content: "hello" });
      expect(result.content).toBe("hello");
    });

    it("should emit message_sent event", async () => {
      const handler = vi.fn();
      gateway.onEvent(handler);
      gateway.addAdapter("cli", createMockAdapter());
      await gateway.sendMessage("cli", { content: "hello" });
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: "message_sent", channelName: "cli" }));
    });

    it("should throw for unknown channel", async () => {
      await expect(gateway.sendMessage("nonexistent", { content: "hi" })).rejects.toThrow("Channel not found");
    });
  });

  describe("getHistory", () => {
    it("should delegate to adapter.getHistory()", async () => {
      const messages = [makeMessage()];
      const adapter = createMockAdapter({ getHistory: vi.fn().mockResolvedValue(messages) });
      gateway.addAdapter("cli", adapter);
      const result = await gateway.getHistory("cli", { limit: 10 });
      expect(adapter.getHistory).toHaveBeenCalledWith({ limit: 10 });
      expect(result).toEqual(messages);
    });
  });

  // ── Event Handlers ──────────────────────────────────────────────────────

  describe("onMessage", () => {
    it("should register and invoke message handler", async () => {
      const handler = vi.fn();
      gateway.onMessage(handler);
      gateway.addAdapter("cli", createMockAdapter());
      const msg = makeMessage();
      await gateway.dispatchMessage(msg, "cli");
      expect(handler).toHaveBeenCalledWith(msg, "cli");
    });

    it("should support multiple handlers", async () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      gateway.onMessage(h1);
      gateway.onMessage(h2);
      gateway.addAdapter("cli", createMockAdapter());
      await gateway.dispatchMessage(makeMessage(), "cli");
      expect(h1).toHaveBeenCalled();
      expect(h2).toHaveBeenCalled();
    });

    it("should return unsubscribe function", async () => {
      const handler = vi.fn();
      const unsub = gateway.onMessage(handler);
      unsub();
      gateway.addAdapter("cli", createMockAdapter());
      await gateway.dispatchMessage(makeMessage(), "cli");
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("onEvent", () => {
    it("should register and invoke event callback", async () => {
      const callback = vi.fn();
      gateway.onEvent(callback);
      gateway.addAdapter("cli", createMockAdapter());
      await gateway.connect("cli");
      expect(callback).toHaveBeenCalled();
    });

    it("should return unsubscribe function", async () => {
      const callback = vi.fn();
      const unsub = gateway.onEvent(callback);
      unsub();
      gateway.addAdapter("cli", createMockAdapter());
      await gateway.connect("cli");
      expect(callback).not.toHaveBeenCalled();
    });
  });

  // ── Session Binding ─────────────────────────────────────────────────────

  describe("bindSession", () => {
    it("should create a session binding", () => {
      gateway.addAdapter("cli", createMockAdapter());
      const binding = gateway.bindSession("cli", "session-1", { userId: "u1" });
      expect(binding.sessionId).toBe("session-1");
      expect(binding.channelName).toBe("cli");
      expect(binding.metadata).toEqual({ userId: "u1" });
      expect(binding.boundAt).toBeTruthy();
    });

    it("should throw ChannelNotFoundError for unknown channel", () => {
      expect(() => gateway.bindSession("nonexistent", "s1")).toThrow("Channel not found");
    });

    it("should overwrite existing binding for same sessionId", () => {
      gateway.addAdapter("cli", createMockAdapter());
      gateway.addAdapter("api", createMockAdapter());
      gateway.bindSession("cli", "s1");
      const binding2 = gateway.bindSession("api", "s1");
      expect(binding2.channelName).toBe("api");
      expect(gateway.getSessionsForChannel("cli")).toHaveLength(0);
      expect(gateway.getSessionsForChannel("api")).toHaveLength(1);
    });
  });

  describe("unbindSession", () => {
    it("should remove a session binding", () => {
      gateway.addAdapter("cli", createMockAdapter());
      gateway.bindSession("cli", "s1");
      expect(gateway.unbindSession("s1")).toBe(true);
      expect(gateway.getSession("s1")).toBeUndefined();
    });

    it("should return false for non-existent session", () => {
      expect(gateway.unbindSession("nonexistent")).toBe(false);
    });
  });

  describe("getSession", () => {
    it("should return undefined for unknown session", () => {
      expect(gateway.getSession("unknown")).toBeUndefined();
    });
  });

  describe("getSessionsForChannel", () => {
    it("should return all sessions bound to a channel", () => {
      gateway.addAdapter("cli", createMockAdapter());
      gateway.addAdapter("api", createMockAdapter());
      gateway.bindSession("cli", "s1");
      gateway.bindSession("cli", "s2");
      gateway.bindSession("api", "s3");
      expect(gateway.getSessionsForChannel("cli")).toHaveLength(2);
      expect(gateway.getSessionsForChannel("api")).toHaveLength(1);
    });

    it("should return empty array for channel with no sessions", () => {
      gateway.addAdapter("cli", createMockAdapter());
      expect(gateway.getSessionsForChannel("cli")).toEqual([]);
    });
  });

  // ── dispatchMessage ─────────────────────────────────────────────────────

  describe("dispatchMessage", () => {
    it("should emit message_received event", async () => {
      const eventHandler = vi.fn();
      gateway.onEvent(eventHandler);
      gateway.addAdapter("cli", createMockAdapter());
      const msg = makeMessage();
      await gateway.dispatchMessage(msg, "cli");
      expect(eventHandler).toHaveBeenCalledWith(expect.objectContaining({
        type: "message_received",
        channelName: "cli",
        message: msg,
      }));
    });

    it("should invoke all registered message handlers", async () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      gateway.onMessage(h1);
      gateway.onMessage(h2);
      gateway.addAdapter("cli", createMockAdapter());
      const msg = makeMessage();
      await gateway.dispatchMessage(msg, "cli");
      expect(h1).toHaveBeenCalledWith(msg, "cli");
      expect(h2).toHaveBeenCalledWith(msg, "cli");
    });

    it("should handle async handlers", async () => {
      const results: string[] = [];
      gateway.onMessage(async (msg) => {
        await new Promise((r) => setTimeout(r, 10));
        results.push(msg.content);
      });
      gateway.addAdapter("cli", createMockAdapter());
      await gateway.dispatchMessage(makeMessage({ content: "async-test" }), "cli");
      expect(results).toEqual(["async-test"]);
    });
  });

  // ── Reconnect ───────────────────────────────────────────────────────────

  describe("auto-reconnect", () => {
    it("should attempt reconnect when autoReconnect is enabled and connect fails", async () => {
      vi.useFakeTimers();
      const adapter = createMockAdapter({
        connect: vi.fn()
          .mockRejectedValueOnce(new Error("fail"))
          .mockResolvedValueOnce(undefined),
      });
      const gw = new ChannelGateway({ autoReconnect: true, reconnectIntervalMs: 100, maxReconnectAttempts: 1 });
      gw.addAdapter("cli", adapter);
      const eventHandler = vi.fn();
      gw.onEvent(eventHandler);

      await gw.connectAll();

      // First connect fails silently (settled result), reconnect scheduled
      vi.advanceTimersByTime(150);
      await vi.runAllTimersAsync();

      // Reconnect should have been attempted
      expect(adapter.connect).toHaveBeenCalledTimes(2);
      expect(eventHandler).toHaveBeenCalledWith(expect.objectContaining({ type: "reconnecting", channelName: "cli" }));

      vi.useRealTimers();
    });
  });
});
