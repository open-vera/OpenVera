import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChannelGateway } from "../gateway.js";
import type {
  ChannelAdapter,
  ChannelMessage,
  ChannelStatus,
  ConnectionState,
  GatewayEvent,
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

  // ── Multi-Channel Concurrent Scenarios (CH7) ──────────────────────────────

  describe("multi-channel lifecycle", () => {
    it("should manage full lifecycle across multiple channels", async () => {
      const cli = createMockAdapter({ name: "cli-adapter", channelType: "cli" });
      const api = createMockAdapter({ name: "api-adapter", channelType: "api" });
      const webhook = createMockAdapter({ name: "webhook-adapter", channelType: "webhook" });

      gateway.addAdapter("cli", cli);
      gateway.addAdapter("api", api);
      gateway.addAdapter("webhook", webhook);
      expect(gateway.listAdapters()).toHaveLength(3);

      // Connect all
      await gateway.connectAll();
      expect(cli.connect).toHaveBeenCalledTimes(1);
      expect(api.connect).toHaveBeenCalledTimes(1);
      expect(webhook.connect).toHaveBeenCalledTimes(1);

      // Send messages through each channel
      await gateway.sendMessage("cli", { content: "cli-msg" });
      await gateway.sendMessage("api", { content: "api-msg" });
      await gateway.sendMessage("webhook", { content: "webhook-msg" });

      // Disconnect all
      await gateway.disconnectAll();
      expect(cli.disconnect).toHaveBeenCalledTimes(1);
      expect(api.disconnect).toHaveBeenCalledTimes(1);
      expect(webhook.disconnect).toHaveBeenCalledTimes(1);
    });

    it("should route messages with correct channel name from different adapters", async () => {
      const received: Array<{ msg: ChannelMessage; channel: string }> = [];
      gateway.onMessage((msg, channel) => { received.push({ msg, channel }); });

      gateway.addAdapter("cli", createMockAdapter({ channelType: "cli" }));
      gateway.addAdapter("api", createMockAdapter({ channelType: "api" }));

      await gateway.dispatchMessage(makeMessage({ id: "m1", content: "from-cli", channelType: "cli" }), "cli");
      await gateway.dispatchMessage(makeMessage({ id: "m2", content: "from-api", channelType: "api" }), "api");

      expect(received).toHaveLength(2);
      expect(received[0].channel).toBe("cli");
      expect(received[0].msg.content).toBe("from-cli");
      expect(received[1].channel).toBe("api");
      expect(received[1].msg.content).toBe("from-api");
    });

    it("should handle concurrent message dispatch from multiple channels", async () => {
      const received: string[] = [];
      gateway.onMessage(async (msg) => {
        await new Promise((r) => setTimeout(r, 5));
        received.push(msg.content);
      });

      gateway.addAdapter("cli", createMockAdapter());
      gateway.addAdapter("api", createMockAdapter());

      // Dispatch concurrently from both channels
      await Promise.all([
        gateway.dispatchMessage(makeMessage({ id: "c1", content: "cli-msg-1" }), "cli"),
        gateway.dispatchMessage(makeMessage({ id: "a1", content: "api-msg-1" }), "api"),
        gateway.dispatchMessage(makeMessage({ id: "c2", content: "cli-msg-2" }), "cli"),
        gateway.dispatchMessage(makeMessage({ id: "a2", content: "api-msg-2" }), "api"),
      ]);

      expect(received).toHaveLength(4);
      expect(received).toContain("cli-msg-1");
      expect(received).toContain("api-msg-1");
      expect(received).toContain("cli-msg-2");
      expect(received).toContain("api-msg-2");
    });

    it("should emit events with correct channel names during multi-channel operations", async () => {
      const events: GatewayEvent[] = [];
      gateway.onEvent((e) => { events.push(e); });

      gateway.addAdapter("cli", createMockAdapter());
      gateway.addAdapter("api", createMockAdapter());

      await gateway.connect("cli");
      await gateway.connect("api");
      await gateway.sendMessage("cli", { content: "hi" });
      await gateway.sendMessage("api", { content: "hello" });
      await gateway.disconnect("cli");

      const connectedEvents = events.filter((e) => e.type === "channel_connected");
      expect(connectedEvents).toHaveLength(2);
      expect(connectedEvents.map((e) => e.channelName).sort()).toEqual(["api", "cli"]);

      const sentEvents = events.filter((e) => e.type === "message_sent");
      expect(sentEvents).toHaveLength(2);
      expect(sentEvents.map((e) => e.channelName).sort()).toEqual(["api", "cli"]);

      const disconnectedEvents = events.filter((e) => e.type === "channel_disconnected");
      expect(disconnectedEvents).toHaveLength(1);
      expect(disconnectedEvents[0].channelName).toBe("cli");
    });

    it("should isolate errors between channels", async () => {
      const cli = createMockAdapter();
      const failingApi = createMockAdapter({
        sendMessage: vi.fn().mockRejectedValue(new Error("api-down")),
      });

      gateway.addAdapter("cli", cli);
      gateway.addAdapter("api", failingApi);

      // CLI send succeeds
      const result = await gateway.sendMessage("cli", { content: "ok" });
      expect(result.content).toBe("ok");

      // API send fails but doesn't affect CLI
      await expect(gateway.sendMessage("api", { content: "fail" })).rejects.toThrow("api-down");

      // CLI still works after API failure
      const result2 = await gateway.sendMessage("cli", { content: "still-ok" });
      expect(result2.content).toBe("still-ok");
    });

    it("should manage session bindings across multiple channels", () => {
      gateway.addAdapter("cli", createMockAdapter());
      gateway.addAdapter("api", createMockAdapter());
      gateway.addAdapter("webhook", createMockAdapter());

      gateway.bindSession("cli", "s1", { user: "alice" });
      gateway.bindSession("api", "s2", { user: "bob" });
      gateway.bindSession("webhook", "s3", { user: "charlie" });
      gateway.bindSession("cli", "s4", { user: "dave" });

      expect(gateway.getSessionsForChannel("cli")).toHaveLength(2);
      expect(gateway.getSessionsForChannel("api")).toHaveLength(1);
      expect(gateway.getSessionsForChannel("webhook")).toHaveLength(1);

      expect(gateway.getSession("s1")?.channelName).toBe("cli");
      expect(gateway.getSession("s2")?.channelName).toBe("api");
      expect(gateway.getSession("s3")?.channelName).toBe("webhook");
    });

    it("should handle connectAll with partial failures gracefully", async () => {
      const ok = createMockAdapter();
      const failing = createMockAdapter({ connect: vi.fn().mockRejectedValue(new Error("timeout")) });

      gateway.addAdapter("ok-channel", ok);
      gateway.addAdapter("fail-channel", failing);

      const results = await gateway.connectAll();
      expect(results).toHaveLength(2);

      // Find which succeeded and which failed regardless of order
      const statuses = results.map((r) => r.status);
      expect(statuses).toContain("fulfilled");
      expect(statuses).toContain("rejected");

      // The successful adapter should have connected
      expect(ok.connect).toHaveBeenCalledTimes(1);
    });

    it("should handle removeAdapter while active in multi-channel setup", async () => {
      const cli = createMockAdapter();
      const api = createMockAdapter();

      gateway.addAdapter("cli", cli);
      gateway.addAdapter("api", api);

      await gateway.connectAll();
      gateway.bindSession("cli", "s1");
      gateway.bindSession("api", "s2");

      // Remove CLI while API is still active
      gateway.removeAdapter("cli");

      expect(gateway.listAdapters()).toHaveLength(1);
      expect(gateway.listAdapters()[0].name).toBe("api");

      // CLI session is cleaned up
      expect(gateway.getSession("s1")).toBeUndefined();
      // API session remains
      expect(gateway.getSession("s2")).toBeDefined();

      // API still works
      await gateway.sendMessage("api", { content: "still-works" });
      expect(api.sendMessage).toHaveBeenCalled();
    });
  });
});
