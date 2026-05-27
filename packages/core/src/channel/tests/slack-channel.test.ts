/**
 * Tests for SlackChannelAdapter.
 *
 * Covers:
 *   - Constructor validation
 *   - Lifecycle (connect/disconnect)
 *   - Message sending via Slack Web API
 *   - Event handling (text, file_share, links)
 *   - Signature verification
 *   - URL verification challenge
 *   - History filtering
 *   - Error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import type { ChannelMessage } from "../types.js";

// Mock fetch selectively — only intercept Slack API calls, pass through local HTTP
const originalFetch = globalThis.fetch;
const mockFetch = vi.fn();
vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url && url.includes("slack.com")) {
    return mockFetch(input, init);
  }
  return originalFetch(input, init);
});

describe("SlackChannelAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function importAdapter() {
    const { SlackChannelAdapter } = await import("../slack-channel.js");
    return SlackChannelAdapter;
  }

  function makeSignature(signingSecret: string, timestamp: string, body: string): string {
    const baseString = `v0:${timestamp}:${body}`;
    const hmac = createHmac("sha256", signingSecret).update(baseString).digest("hex");
    return `v0=${hmac}`;
  }

  function mockAuthTest() {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        url: "https://test.slack.com/",
        team: "TestTeam",
        user: "testbot",
        team_id: "T123",
        user_id: "U123",
        bot_id: "B123",
      }),
    });
  }

  it("should throw if botToken is missing", async () => {
    const Adapter = await importAdapter();
    expect(() => new Adapter({ botToken: "", signingSecret: "secret" })).toThrow("botToken is required");
  });

  it("should throw if signingSecret is missing", async () => {
    const Adapter = await importAdapter();
    expect(() => new Adapter({ botToken: "xoxb-test", signingSecret: "" })).toThrow("signingSecret is required");
  });

  it("should have correct name and channelType", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({ botToken: "xoxb-test", signingSecret: "secret" });
    expect(adapter.name).toBe("slack");
    expect(adapter.channelType).toBe("slack");
    adapter.disconnect();
  });

  it("should start in disconnected state", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({ botToken: "xoxb-test", signingSecret: "secret" });
    expect(adapter.state).toBe("disconnected");
    expect(adapter.getStatus().state).toBe("disconnected");
    adapter.disconnect();
  });

  it("should connect and transition to connected state", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({ botToken: "xoxb-test", signingSecret: "secret" });

    mockAuthTest();
    await adapter.connect();
    expect(adapter.state).toBe("connected");
    expect(adapter.port).toBeGreaterThan(0);

    await adapter.disconnect();
    expect(adapter.state).toBe("disconnected");
  });

  it("should throw ChannelConnectionError when auth.test fails", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({ botToken: "xoxb-bad", signingSecret: "secret" });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "invalid_auth",
    });

    await expect(adapter.connect()).rejects.toThrow("Connection failed");
  });

  it("should send messages via Slack Web API", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({ botToken: "xoxb-test", signingSecret: "secret" });

    mockAuthTest();
    await adapter.connect();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        channel: "C123",
        ts: "1700000000.000001",
        message: { text: "Hello from bot!", ts: "1700000000.000001" },
      }),
    });

    const result = await adapter.sendMessage({
      content: "Hello from bot!",
      channelOptions: { channelId: "C123" },
    });

    expect(result.content).toBe("Hello from bot!");
    expect(result.senderId).toBe("bot");

    // Verify API call was made correctly
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("chat.postMessage"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer xoxb-test",
        }),
      }),
    );

    await adapter.disconnect();
  });

  it("should throw if channelId is missing when sending", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({ botToken: "xoxb-test", signingSecret: "secret" });

    mockAuthTest();
    await adapter.connect();

    await expect(adapter.sendMessage({ content: "Hello" })).rejects.toThrow("channelId is required");

    await adapter.disconnect();
  });

  it("should throw if not connected when sending", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({ botToken: "xoxb-test", signingSecret: "secret" });

    await expect(adapter.sendMessage({
      content: "Hello",
      channelOptions: { channelId: "C123" },
    })).rejects.toThrow("not connected");
  });

  it("should handle URL verification challenge", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({ botToken: "xoxb-test", signingSecret: "test-secret" });

    mockAuthTest();
    await adapter.connect();

    const port = adapter.port;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
      type: "url_verification",
      token: "test-token",
      challenge: "test-challenge-value",
    });
    const signature = makeSignature("test-secret", timestamp, body);

    const resp = await fetch(`http://127.0.0.1:${port}/slack/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Slack-Request-Timestamp": timestamp,
        "X-Slack-Signature": signature,
      },
      body,
    });

    const data = await resp.json() as { challenge: string };
    expect(data.challenge).toBe("test-challenge-value");

    await adapter.disconnect();
  });

  it("should handle incoming message events and notify callbacks", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({ botToken: "xoxb-test", signingSecret: "test-secret" });

    const messages: ChannelMessage[] = [];
    const unsubscribe = adapter.onMessage((msg) => { messages.push(msg); });

    mockAuthTest();
    await adapter.connect();

    const port = adapter.port;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
      token: "test-token",
      team_id: "T123",
      api_app_id: "A123",
      event: {
        type: "message",
        channel: "C123",
        user: "U456",
        text: "Hello from Slack!",
        ts: "1700000000.000001",
      },
      type: "event_callback",
      event_id: "Ev123",
      event_time: 1700000000,
    });
    const signature = makeSignature("test-secret", timestamp, body);

    const resp = await fetch(`http://127.0.0.1:${port}/slack/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Slack-Request-Timestamp": timestamp,
        "X-Slack-Signature": signature,
      },
      body,
    });

    expect(resp.status).toBe(200);

    // Wait for async event processing
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("Hello from Slack!");
    expect(messages[0].senderId).toBe("U456");
    expect(messages[0].channelType).toBe("slack");

    const history = await adapter.getHistory();
    expect(history).toHaveLength(1);

    unsubscribe();
    await adapter.disconnect();
  });

  it("should handle file_share events", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({ botToken: "xoxb-test", signingSecret: "test-secret" });

    const messages: ChannelMessage[] = [];
    adapter.onMessage((msg) => { messages.push(msg); });

    mockAuthTest();
    await adapter.connect();

    const port = adapter.port;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
      token: "test-token",
      team_id: "T123",
      api_app_id: "A123",
      event: {
        type: "message",
        subtype: "file_share",
        channel: "C123",
        user: "U456",
        text: "",
        ts: "1700000000.000001",
        files: [{
          id: "F123",
          name: "test.png",
          title: "Test Image",
          mimetype: "image/png",
          filetype: "png",
          size: 1024,
          url_private: "https://files.slack.com/test.png",
          permalink: "https://test.slack.com/files/test.png",
        }],
      },
      type: "event_callback",
      event_id: "Ev456",
      event_time: 1700000000,
    });
    const signature = makeSignature("test-secret", timestamp, body);

    await fetch(`http://127.0.0.1:${port}/slack/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Slack-Request-Timestamp": timestamp,
        "X-Slack-Signature": signature,
      },
      body,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("[file share]");
    expect(messages[0].attachments).toHaveLength(1);
    expect(messages[0].attachments[0].type).toBe("image");
    expect(messages[0].attachments[0].url).toBe("https://files.slack.com/test.png");

    await adapter.disconnect();
  });

  it("should reject requests with invalid signature", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({ botToken: "xoxb-test", signingSecret: "test-secret" });

    mockAuthTest();
    await adapter.connect();

    const port = adapter.port;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
      type: "url_verification",
      token: "test-token",
      challenge: "challenge",
    });

    const resp = await fetch(`http://127.0.0.1:${port}/slack/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Slack-Request-Timestamp": timestamp,
        "X-Slack-Signature": "v0=invalid-signature-value-here",
      },
      body,
    });

    expect(resp.status).toBe(403);

    await adapter.disconnect();
  });

  it("should reject requests with missing signature headers", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({ botToken: "xoxb-test", signingSecret: "test-secret" });

    mockAuthTest();
    await adapter.connect();

    const port = adapter.port;
    const body = JSON.stringify({
      type: "url_verification",
      token: "test-token",
      challenge: "challenge",
    });

    const resp = await fetch(`http://127.0.0.1:${port}/slack/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    expect(resp.status).toBe(403);

    await adapter.disconnect();
  });

  it("should filter history by senderId", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({ botToken: "xoxb-test", signingSecret: "test-secret" });

    adapter.onMessage(() => {});

    mockAuthTest();
    await adapter.connect();

    const port = adapter.port;

    // Send two messages from different users
    for (const [userId, text] of [["U1", "Message from U1"], ["U2", "Message from U2"]]) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const body = JSON.stringify({
        token: "test-token",
        team_id: "T123",
        api_app_id: "A123",
        event: {
          type: "message",
          channel: "C123",
          user: userId,
          text,
          ts: "1700000000.000001",
        },
        type: "event_callback",
        event_id: `Ev-${userId}`,
        event_time: 1700000000,
      });
      const signature = makeSignature("test-secret", timestamp, body);

      await fetch(`http://127.0.0.1:${port}/slack/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Request-Timestamp": timestamp,
          "X-Slack-Signature": signature,
        },
        body,
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 50));

    const all = await adapter.getHistory();
    expect(all).toHaveLength(2);

    const filtered = await adapter.getHistory({ senderId: "U1" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].senderId).toBe("U1");

    await adapter.disconnect();
  });

  it("should track sent and received counts", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({ botToken: "xoxb-test", signingSecret: "test-secret" });

    adapter.onMessage(() => {});

    mockAuthTest();
    await adapter.connect();

    const port = adapter.port;

    // Receive a message
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
      token: "test-token",
      team_id: "T123",
      api_app_id: "A123",
      event: {
        type: "message",
        channel: "C123",
        user: "U456",
        text: "Hello",
        ts: "1700000000.000001",
      },
      type: "event_callback",
      event_id: "Ev-count",
      event_time: 1700000000,
    });
    const signature = makeSignature("test-secret", timestamp, body);

    await fetch(`http://127.0.0.1:${port}/slack/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Slack-Request-Timestamp": timestamp,
        "X-Slack-Signature": signature,
      },
      body,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Send a message
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        channel: "C123",
        ts: "1700000001.000001",
        message: { text: "Reply", ts: "1700000001.000001" },
      }),
    });

    await adapter.sendMessage({ content: "Reply", channelOptions: { channelId: "C123" } });

    const status = adapter.getStatus();
    expect(status.sentCount).toBe(1);
    expect(status.receivedCount).toBe(1);

    await adapter.disconnect();
  });

  it("should unsubscribe callback when unsubscribe function is called", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({ botToken: "xoxb-test", signingSecret: "test-secret" });

    const messages: ChannelMessage[] = [];
    const unsubscribe = adapter.onMessage((msg) => { messages.push(msg); });

    mockAuthTest();
    await adapter.connect();

    unsubscribe();

    const port = adapter.port;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
      token: "test-token",
      team_id: "T123",
      api_app_id: "A123",
      event: {
        type: "message",
        channel: "C123",
        user: "U456",
        text: "Should not receive",
        ts: "1700000000.000001",
      },
      type: "event_callback",
      event_id: "Ev-unsub",
      event_time: 1700000000,
    });
    const sig = makeSignature("test-secret", timestamp, body);

    await fetch(`http://127.0.0.1:${port}/slack/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Slack-Request-Timestamp": timestamp,
        "X-Slack-Signature": sig,
      },
      body,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(messages).toHaveLength(0);

    await adapter.disconnect();
  });

  it("should ignore bot messages to avoid loops", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({ botToken: "xoxb-test", signingSecret: "test-secret" });

    const messages: ChannelMessage[] = [];
    adapter.onMessage((msg) => { messages.push(msg); });

    mockAuthTest();
    await adapter.connect();

    const port = adapter.port;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
      token: "test-token",
      team_id: "T123",
      api_app_id: "A123",
      event: {
        type: "message",
        channel: "C123",
        user: "U456",
        text: "Bot speaking",
        ts: "1700000000.000001",
        bot_id: "B789",
      },
      type: "event_callback",
      event_id: "Ev-bot",
      event_time: 1700000000,
    });
    const signature = makeSignature("test-secret", timestamp, body);

    await fetch(`http://127.0.0.1:${port}/slack/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Slack-Request-Timestamp": timestamp,
        "X-Slack-Signature": signature,
      },
      body,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(messages).toHaveLength(0);

    await adapter.disconnect();
  });
});
