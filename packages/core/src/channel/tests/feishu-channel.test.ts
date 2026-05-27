/**
 * Feishu Channel Adapter Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FeishuChannelAdapter } from "../feishu-channel.js";

// ── Selective fetch mock — only intercepts Feishu API calls ───────────────────

const originalFetch = globalThis.fetch;
const mockApiFetch = vi.fn();

function mockTokenResponse(token = "test-token-abc", expire = 7200) {
  return {
    ok: true,
    json: () => Promise.resolve({
      code: 0,
      msg: "ok",
      tenant_access_token: token,
      expire,
    }),
  };
}

function mockSendMessageResponse(messageId = "msg-123") {
  return {
    ok: true,
    json: () => Promise.resolve({
      code: 0,
      msg: "ok",
      data: { message_id: messageId },
    }),
  };
}

// Override fetch to route: Feishu API → mock, localhost → real
vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
  const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
  if (urlStr.includes("open.feishu.cn") || urlStr.includes("/auth/v3/") || urlStr.includes("/im/v1/")) {
    return mockApiFetch(url, init);
  }
  return originalFetch(url, init);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("FeishuChannelAdapter", () => {
  const baseConfig = {
    appId: "cli_test-app-id",
    appSecret: "test-app-secret",
    verificationToken: "test-verification-token",
  };

  let adapter: FeishuChannelAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockApiFetch.mockResolvedValue(mockTokenResponse());
  });

  afterEach(async () => {
    if (adapter && adapter.state !== "disconnected") {
      await adapter.disconnect();
    }
  });

  // ── Construction ───────────────────────────────────────────────────────────

  describe("constructor", () => {
    it("should require appId", () => {
      expect(() => new FeishuChannelAdapter({
        ...baseConfig,
        appId: "",
      })).toThrow("appId is required");
    });

    it("should require appSecret", () => {
      expect(() => new FeishuChannelAdapter({
        ...baseConfig,
        appSecret: "",
      })).toThrow("appSecret is required");
    });

    it("should require verificationToken", () => {
      expect(() => new FeishuChannelAdapter({
        ...baseConfig,
        verificationToken: "",
      })).toThrow("verificationToken is required");
    });

    it("should create adapter with valid config", () => {
      adapter = new FeishuChannelAdapter(baseConfig);
      expect(adapter.name).toBe("feishu");
      expect(adapter.channelType).toBe("feishu");
      expect(adapter.state).toBe("disconnected");
    });
  });

  // ── Connection Lifecycle ───────────────────────────────────────────────────

  describe("connect / disconnect", () => {
    it("should connect and validate credentials", async () => {
      adapter = new FeishuChannelAdapter(baseConfig);
      await adapter.connect();

      expect(adapter.state).toBe("connected");
      expect(adapter.port).toBeGreaterThan(0);
      expect(mockApiFetch).toHaveBeenCalledWith(
        expect.stringContaining("/auth/v3/tenant_access_token/internal"),
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("should fail to connect with invalid credentials", async () => {
      mockApiFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 10003, msg: "invalid app_id" }),
      });

      adapter = new FeishuChannelAdapter(baseConfig);
      await expect(adapter.connect()).rejects.toThrow("Failed to obtain tenant_access_token");
      expect(adapter.state).toBe("error");
    });

    it("should disconnect cleanly", async () => {
      adapter = new FeishuChannelAdapter(baseConfig);
      await adapter.connect();
      expect(adapter.state).toBe("connected");

      await adapter.disconnect();
      expect(adapter.state).toBe("disconnected");
    });
  });

  // ── Webhook Event Handling ─────────────────────────────────────────────────

  describe("webhook events", () => {
    it("should respond to url_verification challenge", async () => {
      adapter = new FeishuChannelAdapter(baseConfig);
      await adapter.connect();

      const port = adapter.port;
      const resp = await originalFetch(`http://localhost:${port}/feishu/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "url_verification",
          challenge: "challenge-abc-123",
        }),
      });

      const data = await resp.json();
      expect(data).toEqual({ challenge: "challenge-abc-123" });
    });

    it("should reject requests with invalid verification token", async () => {
      adapter = new FeishuChannelAdapter(baseConfig);
      await adapter.connect();

      const port = adapter.port;
      const resp = await originalFetch(`http://localhost:${port}/feishu/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schema: "2.0",
          header: {
            event_id: "evt-1",
            event_type: "im.message.receive_v1",
            token: "wrong-token",
          },
          event: {},
        }),
      });

      expect(resp.status).toBe(403);
    });

    it("should receive v2 im.message.receive_v1 event", async () => {
      adapter = new FeishuChannelAdapter(baseConfig);
      const messages: unknown[] = [];
      adapter.onMessage((msg) => { messages.push(msg); });
      await adapter.connect();

      const port = adapter.port;
      const resp = await originalFetch(`http://localhost:${port}/feishu/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schema: "2.0",
          header: {
            event_id: "evt-1",
            event_type: "im.message.receive_v1",
            token: "test-verification-token",
          },
          event: {
            message: {
              message_id: "msg-recv-1",
              message_type: "text",
              content: JSON.stringify({ text: "Hello bot!" }),
              chat_id: "oc_chat-123",
            },
            sender: {
              sender_id: { open_id: "ou_user-1" },
            },
          },
        }),
      });

      expect(resp.status).toBe(200);
      await new Promise((r) => setTimeout(r, 100));

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        id: "msg-recv-1",
        channelType: "feishu",
        senderId: "ou_user-1",
        content: "Hello bot!",
      });
    });

    it("should receive v1 message event", async () => {
      adapter = new FeishuChannelAdapter(baseConfig);
      const messages: unknown[] = [];
      adapter.onMessage((msg) => { messages.push(msg); });
      await adapter.connect();

      const port = adapter.port;
      const resp = await originalFetch(`http://localhost:${port}/feishu/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: "message",
          token: "test-verification-token",
          event: {
            msg_type: "text",
            text: "Hello from v1",
            msg_id: "msg-v1-1",
            open_id: "ou_v1-user",
          },
        }),
      });

      expect(resp.status).toBe(200);
      await new Promise((r) => setTimeout(r, 100));

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        content: "Hello from v1",
        senderId: "ou_v1-user",
      });
    });

    it("should handle image messages in v2 events", async () => {
      adapter = new FeishuChannelAdapter(baseConfig);
      const messages: unknown[] = [];
      adapter.onMessage((msg) => { messages.push(msg); });
      await adapter.connect();

      const port = adapter.port;
      await originalFetch(`http://localhost:${port}/feishu/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schema: "2.0",
          header: {
            event_type: "im.message.receive_v1",
            token: "test-verification-token",
          },
          event: {
            message: {
              message_id: "msg-img-1",
              message_type: "image",
              content: JSON.stringify({ image_key: "img-abc-123" }),
            },
            sender: {
              sender_id: { open_id: "ou_user-img" },
            },
          },
        }),
      });

      await new Promise((r) => setTimeout(r, 100));

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        content: "[image]",
        attachments: [{ type: "image", url: "img-abc-123" }],
      });
    });

    it("should return 404 for wrong path", async () => {
      adapter = new FeishuChannelAdapter(baseConfig);
      await adapter.connect();

      const port = adapter.port;
      const resp = await originalFetch(`http://localhost:${port}/wrong/path`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(resp.status).toBe(404);
    });
  });

  // ── Send Message ───────────────────────────────────────────────────────────

  describe("sendMessage", () => {
    it("should send text message via Feishu API", async () => {
      mockApiFetch
        .mockResolvedValueOnce(mockTokenResponse())
        .mockResolvedValueOnce(mockSendMessageResponse("msg-sent-1"));

      adapter = new FeishuChannelAdapter(baseConfig);
      await adapter.connect();

      const result = await adapter.sendMessage({
        content: "Hello from bot!",
        channelOptions: {
          receiveId: "ou_target-user",
          receiveIdType: "open_id",
        },
      });

      expect(result.content).toBe("Hello from bot!");
      expect(result.senderId).toBe("bot");
      expect(result.channelType).toBe("feishu");

      const sendCall = mockApiFetch.mock.calls.find(
        (call: unknown[]) => (call[0] as string).includes("/im/v1/messages"),
      );
      expect(sendCall).toBeTruthy();
    });

    it("should throw when not connected", async () => {
      adapter = new FeishuChannelAdapter(baseConfig);
      await expect(adapter.sendMessage({
        content: "test",
        channelOptions: { receiveId: "ou_xxx" },
      })).rejects.toThrow("not connected");
    });

    it("should throw when receiveId is missing", async () => {
      adapter = new FeishuChannelAdapter(baseConfig);
      await adapter.connect();

      await expect(adapter.sendMessage({
        content: "test",
      })).rejects.toThrow("receiveId is required");
    });

    it("should handle Feishu API error on send", async () => {
      mockApiFetch
        .mockResolvedValueOnce(mockTokenResponse())
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ code: 99991, msg: "rate limit" }),
        });

      adapter = new FeishuChannelAdapter(baseConfig);
      await adapter.connect();

      await expect(adapter.sendMessage({
        content: "test",
        channelOptions: { receiveId: "ou_xxx" },
      })).rejects.toThrow("rate limit");
    });
  });

  // ── Token Management ───────────────────────────────────────────────────────

  describe("token management", () => {
    it("should cache token and not re-fetch while valid", async () => {
      adapter = new FeishuChannelAdapter(baseConfig);
      await adapter.connect();

      mockApiFetch.mockResolvedValueOnce(mockSendMessageResponse("msg-1"));
      await adapter.sendMessage({
        content: "msg 1",
        channelOptions: { receiveId: "ou_xxx" },
      });

      mockApiFetch.mockResolvedValueOnce(mockSendMessageResponse("msg-2"));
      await adapter.sendMessage({
        content: "msg 2",
        channelOptions: { receiveId: "ou_xxx" },
      });

      const tokenCalls = mockApiFetch.mock.calls.filter(
        (call: unknown[]) => (call[0] as string).includes("/auth/v3/tenant_access_token"),
      );
      expect(tokenCalls).toHaveLength(1);
    });
  });

  // ── History & Status ───────────────────────────────────────────────────────

  describe("history and status", () => {
    it("should track message history", async () => {
      adapter = new FeishuChannelAdapter(baseConfig);
      await adapter.connect();

      const port = adapter.port;
      await originalFetch(`http://localhost:${port}/feishu/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schema: "2.0",
          header: { event_type: "im.message.receive_v1", token: "test-verification-token" },
          event: {
            message: {
              message_id: "msg-hist-1",
              message_type: "text",
              content: JSON.stringify({ text: "history test" }),
            },
            sender: { sender_id: { open_id: "ou_hist" } },
          },
        }),
      });

      await new Promise((r) => setTimeout(r, 100));

      const history = await adapter.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].content).toBe("history test");
    });

    it("should report correct status", async () => {
      adapter = new FeishuChannelAdapter(baseConfig);
      await adapter.connect();

      const status = adapter.getStatus();
      expect(status.state).toBe("connected");
      expect(status.sentCount).toBe(0);
      expect(status.receivedCount).toBe(0);
      expect(status.message).toContain("Feishu bot");
    });
  });
});
