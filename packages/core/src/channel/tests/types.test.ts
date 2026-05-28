/**
 * Tests for Channel types — verify type contracts, error constructors, and
 * interface compatibility through structural typing checks.
 */
import { describe, it, expect } from "vitest";
import type {
  ChannelType,
  ChannelAttachment,
  ChannelMessage,
  ConnectionState,
  ChannelStatus,
  MessageCallback,
  SendMessageOptions,
  HistoryOptions,
  ChannelAdapter,
  GatewayConfig,
  GatewayEvent,
  GatewayEventCallback,
} from "../types.js";
import {
  ChannelError,
  ChannelConnectionError,
  ChannelSendError,
  ChannelTimeoutError,
  ChannelNotConnectedError,
  ChannelNotFoundError,
} from "../types.js";

// ── Error Classes ────────────────────────────────────────────────────────────

describe("Channel Error Classes", () => {
  describe("ChannelError", () => {
    it("should create with code and message", () => {
      const err = new ChannelError("TEST_CODE", "test message");
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(ChannelError);
      expect(err.code).toBe("TEST_CODE");
      expect(err.message).toBe("test message");
      expect(err.name).toBe("ChannelError");
    });

    it("should support cause chaining", () => {
      const cause = new Error("root cause");
      const err = new ChannelError("CHAIN", "wrapped", { cause });
      expect(err.cause).toBe(cause);
    });
  });

  describe("ChannelConnectionError", () => {
    it("should include channel name and detail in message", () => {
      const err = new ChannelConnectionError("slack", "timeout");
      expect(err.code).toBe("CHANNEL_CONNECTION");
      expect(err.message).toContain("slack");
      expect(err.message).toContain("timeout");
      expect(err.name).toBe("ChannelConnectionError");
    });

    it("should support cause chaining", () => {
      const cause = new Error("ECONNREFUSED");
      const err = new ChannelConnectionError("feishu", "refused", { cause });
      expect(err.cause).toBe(cause);
    });
  });

  describe("ChannelSendError", () => {
    it("should include channel name and detail in message", () => {
      const err = new ChannelSendError("telegram", "rate limited");
      expect(err.code).toBe("CHANNEL_SEND");
      expect(err.message).toContain("telegram");
      expect(err.message).toContain("rate limited");
      expect(err.name).toBe("ChannelSendError");
    });
  });

  describe("ChannelTimeoutError", () => {
    it("should include channel name and timeout in message", () => {
      const err = new ChannelTimeoutError("discord", 5000);
      expect(err.code).toBe("CHANNEL_TIMEOUT");
      expect(err.message).toContain("discord");
      expect(err.message).toContain("5000");
      expect(err.name).toBe("ChannelTimeoutError");
    });
  });

  describe("ChannelNotConnectedError", () => {
    it("should include channel name in message", () => {
      const err = new ChannelNotConnectedError("slack");
      expect(err.code).toBe("CHANNEL_NOT_CONNECTED");
      expect(err.message).toContain("slack");
      expect(err.name).toBe("ChannelNotConnectedError");
    });
  });

  describe("ChannelNotFoundError", () => {
    it("should include channel name in message", () => {
      const err = new ChannelNotFoundError("nonexistent");
      expect(err.code).toBe("CHANNEL_NOT_FOUND");
      expect(err.message).toContain("nonexistent");
      expect(err.name).toBe("ChannelNotFoundError");
    });
  });

  describe("error hierarchy", () => {
    it("all channel errors should extend ChannelError", () => {
      const errors = [
        new ChannelConnectionError("ch", "detail"),
        new ChannelSendError("ch", "detail"),
        new ChannelTimeoutError("ch", 1000),
        new ChannelNotConnectedError("ch"),
        new ChannelNotFoundError("ch"),
      ];
      for (const err of errors) {
        expect(err).toBeInstanceOf(ChannelError);
        expect(err).toBeInstanceOf(Error);
      }
    });
  });
});

// ── ChannelMessage Structure ─────────────────────────────────────────────────

describe("ChannelMessage structure", () => {
  it("should accept a valid message with all required fields", () => {
    const msg: ChannelMessage = {
      id: "msg-1",
      channelType: "cli",
      senderId: "user-1",
      content: "hello",
      attachments: [],
      timestamp: new Date().toISOString(),
    };
    expect(msg.id).toBe("msg-1");
    expect(msg.channelType).toBe("cli");
    expect(msg.attachments).toHaveLength(0);
  });

  it("should accept optional fields", () => {
    const msg: ChannelMessage = {
      id: "msg-2",
      channelType: "slack",
      senderId: "U12345",
      senderName: "Alice",
      content: "hello with reply",
      attachments: [{ type: "image", url: "https://example.com/img.png", name: "img.png" }],
      replyTo: "msg-1",
      timestamp: new Date().toISOString(),
      raw: { slack_ts: "1234567890.123456" },
    };
    expect(msg.senderName).toBe("Alice");
    expect(msg.replyTo).toBe("msg-1");
    expect(msg.attachments).toHaveLength(1);
    expect(msg.raw).toBeDefined();
  });
});

describe("ChannelAttachment structure", () => {
  it("should accept minimal attachment", () => {
    const att: ChannelAttachment = { type: "file", url: "/tmp/doc.pdf" };
    expect(att.type).toBe("file");
    expect(att.url).toBe("/tmp/doc.pdf");
    expect(att.name).toBeUndefined();
  });

  it("should accept full attachment", () => {
    const att: ChannelAttachment = {
      type: "image",
      url: "https://example.com/pic.jpg",
      name: "pic.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1024,
    };
    expect(att.mimeType).toBe("image/jpeg");
    expect(att.sizeBytes).toBe(1024);
  });

  it("should accept all attachment types", () => {
    const types: ChannelAttachment["type"][] = ["image", "file", "audio", "video", "link"];
    for (const type of types) {
      const att: ChannelAttachment = { type, url: "test" };
      expect(att.type).toBe(type);
    }
  });
});

// ── ChannelType Values ───────────────────────────────────────────────────────

describe("ChannelType values", () => {
  it("should accept all defined channel types", () => {
    const types: ChannelType[] = [
      "cli", "api", "webhook", "feishu", "wecom",
      "telegram", "discord", "slack", "whatsapp", "custom",
    ];
    expect(types).toHaveLength(10);
    for (const t of types) {
      expect(typeof t).toBe("string");
    }
  });
});

// ── ConnectionState Values ────────────────────────────────────────────────────

describe("ConnectionState values", () => {
  it("should accept all defined states", () => {
    const states: ConnectionState[] = ["disconnected", "connecting", "connected", "error"];
    expect(states).toHaveLength(4);
  });
});

// ── ChannelStatus Structure ──────────────────────────────────────────────────

describe("ChannelStatus structure", () => {
  it("should accept a valid status", () => {
    const status: ChannelStatus = {
      state: "connected",
      message: "All good",
      changedAt: new Date().toISOString(),
      sentCount: 10,
      receivedCount: 5,
    };
    expect(status.state).toBe("connected");
    expect(status.sentCount).toBe(10);
  });
});

// ── SendMessageOptions Structure ─────────────────────────────────────────────

describe("SendMessageOptions structure", () => {
  it("should accept minimal options", () => {
    const opts: SendMessageOptions = { content: "hello" };
    expect(opts.content).toBe("hello");
    expect(opts.attachments).toBeUndefined();
  });

  it("should accept full options", () => {
    const opts: SendMessageOptions = {
      content: "hello",
      attachments: [{ type: "file", url: "/tmp/test.txt" }],
      replyTo: "msg-1",
      channelOptions: { parse_mode: "Markdown" },
    };
    expect(opts.replyTo).toBe("msg-1");
    expect(opts.channelOptions?.parse_mode).toBe("Markdown");
  });
});

// ── HistoryOptions Structure ─────────────────────────────────────────────────

describe("HistoryOptions structure", () => {
  it("should accept empty options", () => {
    const opts: HistoryOptions = {};
    expect(opts.limit).toBeUndefined();
  });

  it("should accept full options", () => {
    const opts: HistoryOptions = {
      limit: 50,
      after: "2026-01-01T00:00:00Z",
      before: "2026-12-31T23:59:59Z",
      senderId: "user-1",
    };
    expect(opts.limit).toBe(50);
    expect(opts.senderId).toBe("user-1");
  });
});

// ── GatewayConfig Structure ──────────────────────────────────────────────────

describe("GatewayConfig structure", () => {
  it("should accept empty config", () => {
    const config: GatewayConfig = {};
    expect(config.maxConnections).toBeUndefined();
  });

  it("should accept full config", () => {
    const config: GatewayConfig = {
      maxConnections: 10,
      defaultTimeoutMs: 30000,
      autoReconnect: true,
      reconnectIntervalMs: 5000,
      maxReconnectAttempts: 3,
    };
    expect(config.maxConnections).toBe(10);
    expect(config.autoReconnect).toBe(true);
  });
});

// ── GatewayEvent Structure ───────────────────────────────────────────────────

describe("GatewayEvent structure", () => {
  it("should accept channel_connected event", () => {
    const event: GatewayEvent = { type: "channel_connected", channelName: "slack" };
    expect(event.type).toBe("channel_connected");
  });

  it("should accept channel_disconnected event", () => {
    const event: GatewayEvent = { type: "channel_disconnected", channelName: "slack", reason: "timeout" };
    expect(event.reason).toBe("timeout");
  });

  it("should accept channel_error event", () => {
    const event: GatewayEvent = { type: "channel_error", channelName: "feishu", error: "auth failed" };
    expect(event.error).toBe("auth failed");
  });

  it("should accept message_received event", () => {
    const msg: ChannelMessage = {
      id: "msg-1",
      channelType: "telegram",
      senderId: "user-1",
      content: "hi",
      attachments: [],
      timestamp: new Date().toISOString(),
    };
    const event: GatewayEvent = { type: "message_received", channelName: "telegram", message: msg };
    expect(event.message.content).toBe("hi");
  });

  it("should accept reconnecting event", () => {
    const event: GatewayEvent = { type: "reconnecting", channelName: "discord", attempt: 2 };
    expect(event.attempt).toBe(2);
  });
});

// ── ChannelAdapter Interface Compliance ──────────────────────────────────────

describe("ChannelAdapter interface compliance", () => {
  it("should accept a mock implementation", () => {
    const mockAdapter: ChannelAdapter = {
      name: "test-adapter",
      channelType: "custom",
      state: "disconnected",
      connect: async () => {},
      disconnect: async () => {},
      getStatus: () => ({
        state: "disconnected",
        changedAt: new Date().toISOString(),
        sentCount: 0,
        receivedCount: 0,
      }),
      sendMessage: async (opts) => ({
        id: "sent-1",
        channelType: "custom",
        senderId: "bot",
        content: opts.content,
        attachments: opts.attachments ?? [],
        timestamp: new Date().toISOString(),
      }),
      onMessage: (_callback: MessageCallback) => () => {},
      getHistory: async () => [],
    };
    expect(mockAdapter.name).toBe("test-adapter");
    expect(mockAdapter.channelType).toBe("custom");
    expect(mockAdapter.state).toBe("disconnected");
  });

  it("should support connect/disconnect lifecycle", async () => {
    let connected = false;
    const adapter: ChannelAdapter = {
      name: "lifecycle-test",
      channelType: "cli",
      get state() { return connected ? "connected" as const : "disconnected" as const; },
      connect: async () => { connected = true; },
      disconnect: async () => { connected = false; },
      getStatus: () => ({
        state: connected ? "connected" : "disconnected",
        changedAt: new Date().toISOString(),
        sentCount: 0,
        receivedCount: 0,
      }),
      sendMessage: async (opts) => ({
        id: "msg-1",
        channelType: "cli",
        senderId: "bot",
        content: opts.content,
        attachments: [],
        timestamp: new Date().toISOString(),
      }),
      onMessage: () => () => {},
      getHistory: async () => [],
    };

    expect(adapter.state).toBe("disconnected");
    await adapter.connect();
    expect(adapter.state).toBe("connected");
    const status = adapter.getStatus();
    expect(status.state).toBe("connected");
    await adapter.disconnect();
    expect(adapter.state).toBe("disconnected");
  });

  it("should support message sending and receiving", async () => {
    const received: ChannelMessage[] = [];
    const adapter: ChannelAdapter = {
      name: "messaging-test",
      channelType: "api",
      state: "connected",
      connect: async () => {},
      disconnect: async () => {},
      getStatus: () => ({
        state: "connected",
        changedAt: new Date().toISOString(),
        sentCount: 1,
        receivedCount: 1,
      }),
      sendMessage: async (opts) => ({
        id: `sent-${Date.now()}`,
        channelType: "api",
        senderId: "bot",
        content: opts.content,
        attachments: opts.attachments ?? [],
        timestamp: new Date().toISOString(),
      }),
      onMessage: (callback: MessageCallback) => {
        // Simulate an incoming message
        const msg: ChannelMessage = {
          id: "incoming-1",
          channelType: "api",
          senderId: "user-1",
          content: "hello from user",
          attachments: [],
          timestamp: new Date().toISOString(),
        };
        callback(msg);
        return () => {};
      },
      getHistory: async () => received,
    };

    // Register callback
    const unsubscribe = adapter.onMessage((msg) => { received.push(msg); });
    expect(received).toHaveLength(1);
    expect(received[0].content).toBe("hello from user");

    // Send a message
    const sent = await adapter.sendMessage({ content: "hello from bot" });
    expect(sent.content).toBe("hello from bot");
    expect(sent.channelType).toBe("api");

    // Unsubscribe
    expect(typeof unsubscribe).toBe("function");
  });

  it("should support history retrieval with filters", async () => {
    const history: ChannelMessage[] = [
      {
        id: "msg-1",
        channelType: "slack",
        senderId: "user-1",
        content: "first",
        attachments: [],
        timestamp: "2026-01-01T00:00:00Z",
      },
      {
        id: "msg-2",
        channelType: "slack",
        senderId: "user-2",
        content: "second",
        attachments: [],
        timestamp: "2026-01-02T00:00:00Z",
      },
    ];

    const adapter: ChannelAdapter = {
      name: "history-test",
      channelType: "slack",
      state: "connected",
      connect: async () => {},
      disconnect: async () => {},
      getStatus: () => ({
        state: "connected",
        changedAt: new Date().toISOString(),
        sentCount: 0,
        receivedCount: 2,
      }),
      sendMessage: async (opts) => ({
        id: "sent-1",
        channelType: "slack",
        senderId: "bot",
        content: opts.content,
        attachments: [],
        timestamp: new Date().toISOString(),
      }),
      onMessage: () => () => {},
      getHistory: async (opts) => {
        let result = [...history];
        if (opts?.senderId) result = result.filter((m) => m.senderId === opts.senderId);
        if (opts?.limit) result = result.slice(0, opts.limit);
        return result;
      },
    };

    const all = await adapter.getHistory();
    expect(all).toHaveLength(2);

    const filtered = await adapter.getHistory({ senderId: "user-1" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].senderId).toBe("user-1");

    const limited = await adapter.getHistory({ limit: 1 });
    expect(limited).toHaveLength(1);
  });
});
