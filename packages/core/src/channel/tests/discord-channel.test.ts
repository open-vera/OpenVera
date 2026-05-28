/**
 * Tests for DiscordChannelAdapter.
 *
 * Covers:
 *   - Constructor validation
 *   - Lifecycle (connect/disconnect)
 *   - Message sending via REST API
 *   - Gateway WebSocket message handling
 *   - Heartbeat mechanism
 *   - History filtering
 *   - Error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChannelMessage, MessageCallback } from "../types.js";

// Mock WebSocket
class MockWebSocket {
  static instances: MockWebSocket[] = [];

  readyState = 0; // CONNECTING
  url: string;
  listeners: Record<string, Array<(event: unknown) => void>> = {};
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    // Auto-open after a tick
    setTimeout(() => {
      this.readyState = 1; // OPEN
      this.dispatchEvent("open", {});
    }, 1);
  }

  addEventListener(event: string, listener: (event: unknown) => void): void {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3; // CLOSED
    this.dispatchEvent("close", { code, reason, wasClean: true });
  }

  dispatchEvent(event: string, data: unknown): void {
    for (const listener of this.listeners[event] ?? []) {
      listener(typeof data === "object" && data !== null && "data" in (data as Record<string, unknown>)
        ? data
        : { data: JSON.stringify(data) });
    }
  }
}

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
vi.stubGlobal("WebSocket", MockWebSocket);

describe("DiscordChannelAdapter", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function importAdapter() {
    // Dynamic import to get fresh module with mocked globals
    const { DiscordChannelAdapter } = await import("../discord-channel.js");
    return DiscordChannelAdapter;
  }

  function getLatestWs(): MockWebSocket {
    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    if (!ws) throw new Error("No WebSocket instance created");
    return ws;
  }

  function simulateHello(ws: MockWebSocket, heartbeatInterval = 41250): void {
    ws.dispatchEvent("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: heartbeatInterval } }) });
  }

  function simulateReady(ws: MockWebSocket, sessionId = "test-session"): void {
    ws.dispatchEvent("message", {
      data: JSON.stringify({
        op: 0,
        t: "READY",
        s: 1,
        d: {
          v: 10,
          user: { id: "bot-id", username: "TestBot", discriminator: "0001" },
          guilds: [{ id: "guild-1" }],
          session_id: sessionId,
          resume_gateway_url: "wss://us-east1.discord.gg",
        },
      }),
    });
  }

  it("should throw if botToken is missing", async () => {
    const Adapter = await importAdapter();
    expect(() => new Adapter({ botToken: "" })).toThrow("botToken is required");
  });

  it("should have correct name and channelType", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({ botToken: "test-token" });
    expect(adapter.name).toBe("discord");
    expect(adapter.channelType).toBe("discord");
  });

  it("should start in disconnected state", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({ botToken: "test-token" });
    expect(adapter.state).toBe("disconnected");
    expect(adapter.getStatus().state).toBe("disconnected");
  });

  it("should connect to Gateway and transition to connected", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({ botToken: "test-token" });

    const connectPromise = adapter.connect();

    const ws = getLatestWs();
    simulateHello(ws);
    simulateReady(ws);

    await connectPromise;
    expect(adapter.state).toBe("connected");

    await adapter.disconnect();
  });

  it("should send identify after hello", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({ botToken: "test-token" });

    const connectPromise = adapter.connect();

    const ws = getLatestWs();
    simulateHello(ws);
    simulateReady(ws);

    await connectPromise;

    // Should have sent identify
    const identifyMsg = ws.sent.find((s) => JSON.parse(s).op === 2);
    expect(identifyMsg).toBeDefined();
    const identify = JSON.parse(identifyMsg!);
    expect(identify.d.token).toBe("Bot test-token");
    expect(identify.d.intents).toBeGreaterThan(0);

    await adapter.disconnect();
  });

  it("should send heartbeat after hello", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({ botToken: "test-token" });

    const connectPromise = adapter.connect();

    const ws = getLatestWs();
    // Use short heartbeat interval for testing
    simulateHello(ws, 50);
    simulateReady(ws);

    await connectPromise;

    // Heartbeat is sent after jitter delay, wait for it
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Should have sent heartbeat (op 1)
    const heartbeatMsg = ws.sent.find((s) => JSON.parse(s).op === 1);
    expect(heartbeatMsg).toBeDefined();

    await adapter.disconnect();
  });

  it("should handle incoming messages and notify callbacks", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({ botToken: "test-token" });

    const messages: ChannelMessage[] = [];
    const unsubscribe = adapter.onMessage((msg) => { messages.push(msg); });

    const connectPromise = adapter.connect();

    const ws = getLatestWs();
    simulateHello(ws);
    simulateReady(ws);

    await connectPromise;

    // Simulate MESSAGE_CREATE
    ws.dispatchEvent("message", {
      data: JSON.stringify({
        op: 0,
        t: "MESSAGE_CREATE",
        s: 2,
        d: {
          id: "msg-1",
          channel_id: "ch-1",
          guild_id: "guild-1",
          author: { id: "user-1", username: "alice", discriminator: "0001", bot: false },
          content: "Hello bot!",
          timestamp: "2026-01-01T00:00:00.000Z",
          tts: false,
          mention_everyone: false,
          mentions: [],
          attachments: [],
          embeds: [],
          type: 0,
        },
      }),
    });

    // Wait for async processing
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("Hello bot!");
    expect(messages[0].senderId).toBe("user-1");
    expect(messages[0].senderName).toBe("alice#0001");
    expect(messages[0].replyTo).toBeUndefined();

    // Check history
    const history = await adapter.getHistory();
    expect(history).toHaveLength(1);

    unsubscribe();
    await adapter.disconnect();
  });

  it("should ignore bot messages", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({ botToken: "test-token" });

    const messages: ChannelMessage[] = [];
    adapter.onMessage((msg) => { messages.push(msg); });

    const connectPromise = adapter.connect();

    const ws = getLatestWs();
    simulateHello(ws);
    simulateReady(ws);

    await connectPromise;

    // Simulate bot MESSAGE_CREATE
    ws.dispatchEvent("message", {
      data: JSON.stringify({
        op: 0,
        t: "MESSAGE_CREATE",
        s: 2,
        d: {
          id: "msg-bot",
          channel_id: "ch-1",
          author: { id: "bot-2", username: "other-bot", discriminator: "0000", bot: true },
          content: "I am a bot",
          timestamp: "2026-01-01T00:00:00.000Z",
          tts: false,
          mention_everyone: false,
          mentions: [],
          attachments: [],
          embeds: [],
          type: 0,
        },
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(messages).toHaveLength(0);

    await adapter.disconnect();
  });

  it("should handle message with attachments", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({ botToken: "test-token" });

    const messages: ChannelMessage[] = [];
    adapter.onMessage((msg) => { messages.push(msg); });

    const connectPromise = adapter.connect();

    const ws = getLatestWs();
    simulateHello(ws);
    simulateReady(ws);

    await connectPromise;

    ws.dispatchEvent("message", {
      data: JSON.stringify({
        op: 0,
        t: "MESSAGE_CREATE",
        s: 2,
        d: {
          id: "msg-att",
          channel_id: "ch-1",
          author: { id: "user-1", username: "alice", discriminator: "0001", bot: false },
          content: "Check this image",
          timestamp: "2026-01-01T00:00:00.000Z",
          tts: false,
          mention_everyone: false,
          mentions: [],
          attachments: [{
            id: "att-1",
            filename: "photo.png",
            content_type: "image/png",
            size: 1024,
            url: "https://cdn.discord.com/attachments/photo.png",
            proxy_url: "https://media.discord.com/attachments/photo.png",
            width: 100,
            height: 100,
          }],
          embeds: [],
          type: 0,
        },
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(messages).toHaveLength(1);
    expect(messages[0].attachments).toHaveLength(1);
    expect(messages[0].attachments[0].type).toBe("image");
    expect(messages[0].attachments[0].url).toBe("https://cdn.discord.com/attachments/photo.png");

    await adapter.disconnect();
  });

  it("should handle reply references", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({ botToken: "test-token" });

    const messages: ChannelMessage[] = [];
    adapter.onMessage((msg) => { messages.push(msg); });

    const connectPromise = adapter.connect();

    const ws = getLatestWs();
    simulateHello(ws);
    simulateReady(ws);

    await connectPromise;

    ws.dispatchEvent("message", {
      data: JSON.stringify({
        op: 0,
        t: "MESSAGE_CREATE",
        s: 2,
        d: {
          id: "msg-reply",
          channel_id: "ch-1",
          author: { id: "user-1", username: "alice", discriminator: "0001", bot: false },
          content: "Replying to you",
          timestamp: "2026-01-01T00:00:00.000Z",
          tts: false,
          mention_everyone: false,
          mentions: [],
          attachments: [],
          embeds: [],
          message_reference: { message_id: "msg-original", channel_id: "ch-1", guild_id: "guild-1" },
          type: 0,
        },
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(messages).toHaveLength(1);
    expect(messages[0].replyTo).toBe("msg-original");

    await adapter.disconnect();
  });

  it("should send messages via REST API", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({ botToken: "test-token" });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: "sent-msg-1",
        channel_id: "ch-1",
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    });

    const connectPromise = adapter.connect();
    const ws = getLatestWs();
    simulateHello(ws);
    simulateReady(ws);
    await connectPromise;

    const result = await adapter.sendMessage({
      content: "Hello from bot!",
      channelOptions: { channelId: "ch-1" },
    });

    expect(result.id).toBe("sent-msg-1");
    expect(result.content).toBe("Hello from bot!");
    expect(result.senderId).toBe("bot");

    // Verify API call
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/channels/ch-1/messages"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bot test-token",
        }),
      }),
    );

    await adapter.disconnect();
  });

  it("should throw if channelId is missing when sending", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({ botToken: "test-token" });

    const connectPromise = adapter.connect();
    const ws = getLatestWs();
    simulateHello(ws);
    simulateReady(ws);
    await connectPromise;

    await expect(adapter.sendMessage({ content: "Hello" })).rejects.toThrow("channelId is required");

    await adapter.disconnect();
  });

  it("should throw if not connected when sending", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({ botToken: "test-token" });

    await expect(adapter.sendMessage({
      content: "Hello",
      channelOptions: { channelId: "ch-1" },
    })).rejects.toThrow("not connected");
  });

  it("should filter history by senderId", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({ botToken: "test-token" });

    adapter.onMessage(() => {});

    const connectPromise = adapter.connect();
    const ws = getLatestWs();
    simulateHello(ws);
    simulateReady(ws);
    await connectPromise;

    // Add two messages from different senders
    for (const [id, userId] of [["m1", "u1"], ["m2", "u2"]]) {
      ws.dispatchEvent("message", {
        data: JSON.stringify({
          op: 0,
          t: "MESSAGE_CREATE",
          s: 2,
          d: {
            id,
            channel_id: "ch-1",
            author: { id: userId, username: `user-${userId}`, discriminator: "0001", bot: false },
            content: `Message from ${userId}`,
            timestamp: "2026-01-01T00:00:00.000Z",
            tts: false,
            mention_everyone: false,
            mentions: [],
            attachments: [],
            embeds: [],
            type: 0,
          },
        }),
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 10));

    const all = await adapter.getHistory();
    expect(all).toHaveLength(2);

    const filtered = await adapter.getHistory({ senderId: "u1" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].senderId).toBe("u1");

    await adapter.disconnect();
  });

  it("should track sent and received counts", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({ botToken: "test-token" });

    adapter.onMessage(() => {});

    const connectPromise = adapter.connect();
    const ws = getLatestWs();
    simulateHello(ws);
    simulateReady(ws);
    await connectPromise;

    // Receive a message
    ws.dispatchEvent("message", {
      data: JSON.stringify({
        op: 0,
        t: "MESSAGE_CREATE",
        s: 2,
        d: {
          id: "m1",
          channel_id: "ch-1",
          author: { id: "u1", username: "user", discriminator: "0001", bot: false },
          content: "Hello",
          timestamp: "2026-01-01T00:00:00.000Z",
          tts: false,
          mention_everyone: false,
          mentions: [],
          attachments: [],
          embeds: [],
          type: 0,
        },
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Send a message
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "sent-1", channel_id: "ch-1", timestamp: "2026-01-01T00:00:01.000Z" }),
    });

    await adapter.sendMessage({ content: "Reply", channelOptions: { channelId: "ch-1" } });

    const status = adapter.getStatus();
    expect(status.sentCount).toBe(1);
    expect(status.receivedCount).toBe(1);

    await adapter.disconnect();
  });

  it("should unsubscribe callback when unsubscribe function is called", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({ botToken: "test-token" });

    const messages: ChannelMessage[] = [];
    const unsubscribe = adapter.onMessage((msg) => { messages.push(msg); });

    const connectPromise = adapter.connect();
    const ws = getLatestWs();
    simulateHello(ws);
    simulateReady(ws);
    await connectPromise;

    // Unsubscribe
    unsubscribe();

    // Send a message
    ws.dispatchEvent("message", {
      data: JSON.stringify({
        op: 0,
        t: "MESSAGE_CREATE",
        s: 2,
        d: {
          id: "m1",
          channel_id: "ch-1",
          author: { id: "u1", username: "user", discriminator: "0001", bot: false },
          content: "Should not receive",
          timestamp: "2026-01-01T00:00:00.000Z",
          tts: false,
          mention_everyone: false,
          mentions: [],
          attachments: [],
          embeds: [],
          type: 0,
        },
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(messages).toHaveLength(0);

    await adapter.disconnect();
  });

  it("should clean up on disconnect", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({ botToken: "test-token" });

    const connectPromise = adapter.connect();
    const ws = getLatestWs();
    simulateHello(ws);
    simulateReady(ws);
    await connectPromise;

    expect(adapter.state).toBe("connected");

    await adapter.disconnect();
    expect(adapter.state).toBe("disconnected");
    expect(adapter.getStatus().state).toBe("disconnected");
  });
});
