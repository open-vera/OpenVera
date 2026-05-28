/**
 * Telegram Bot Channel Adapter Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TelegramChannelAdapter } from "../telegram-channel.js";

// ── Selective fetch mock — only intercepts Telegram API calls ──────────────────

const originalFetch = globalThis.fetch;
const mockApiFetch = vi.fn();

function mockGetMeResponse() {
  return {
    ok: true,
    json: () => Promise.resolve({
      ok: true,
      result: { id: 123456789, is_bot: true, first_name: "TestBot", username: "test_bot" },
    }),
  };
}

function mockSendMessageResponse(messageId = 42) {
  return {
    ok: true,
    json: () => Promise.resolve({
      ok: true,
      result: {
        message_id: messageId,
        chat: { id: 100, type: "private" },
        date: Math.floor(Date.now() / 1000),
        text: "test",
      },
    }),
  };
}

function mockSendPhotoResponse(messageId = 43) {
  return {
    ok: true,
    json: () => Promise.resolve({
      ok: true,
      result: {
        message_id: messageId,
        chat: { id: 100, type: "private" },
        date: Math.floor(Date.now() / 1000),
      },
    }),
  };
}

function mockGetUpdatesResponse(updates: Array<{ update_id: number; message?: unknown }> = []) {
  return {
    ok: true,
    json: () => Promise.resolve({
      ok: true,
      result: updates,
    }),
  };
}

function mockSetWebhookResponse() {
  return {
    ok: true,
    json: () => Promise.resolve({ ok: true, result: true }),
  };
}

function mockDeleteWebhookResponse() {
  return {
    ok: true,
    json: () => Promise.resolve({ ok: true, result: true }),
  };
}

// Override fetch to route: Telegram API → mock, localhost → real
vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
  const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
  if (urlStr.includes("api.telegram.org")) {
    return mockApiFetch(url, init);
  }
  return originalFetch(url, init);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("TelegramChannelAdapter", () => {
  const baseConfig = {
    botToken: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
  };

  let adapter: TelegramChannelAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockApiFetch.mockResolvedValue(mockGetMeResponse());
  });

  afterEach(async () => {
    if (adapter && adapter.state !== "disconnected") {
      await adapter.disconnect();
    }
  });

  // ── Construction ───────────────────────────────────────────────────────────

  describe("constructor", () => {
    it("should require botToken", () => {
      expect(() => new TelegramChannelAdapter({ botToken: "" })).toThrow("botToken is required");
    });

    it("should create adapter with valid config", () => {
      adapter = new TelegramChannelAdapter(baseConfig);
      expect(adapter.name).toBe("telegram");
      expect(adapter.channelType).toBe("telegram");
      expect(adapter.state).toBe("disconnected");
    });

    it("should default to long-polling mode", () => {
      adapter = new TelegramChannelAdapter(baseConfig);
      expect(adapter.getStatus().state).toBe("disconnected");
    });

    it("should accept webhook mode config", () => {
      adapter = new TelegramChannelAdapter({
        ...baseConfig,
        mode: "webhook",
        webhookUrl: "https://example.com/webhook",
      });
      expect(adapter.channelType).toBe("telegram");
    });
  });

  // ── Connection ─────────────────────────────────────────────────────────────

  describe("connect (long-polling)", () => {
    it("should connect successfully with valid token", async () => {
      // Mock getUpdates to return empty and then block
      let getUpdatesCalls = 0;
      mockApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        const urlStr = url.toString();
        if (urlStr.includes("getMe")) return mockGetMeResponse();
        if (urlStr.includes("getUpdates")) {
          getUpdatesCalls++;
          if (getUpdatesCalls <= 2) return mockGetUpdatesResponse([]);
          // Subsequent calls: simulate long-running request that we abort
          return mockGetUpdatesResponse([]);
        }
        return { ok: true, json: () => Promise.resolve({ ok: true, result: {} }) };
      });

      adapter = new TelegramChannelAdapter(baseConfig);
      await adapter.connect();
      expect(adapter.state).toBe("connected");
    });

    it("should throw on invalid token", async () => {
      mockApiFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: false, description: "Unauthorized", error_code: 401 }),
      });

      adapter = new TelegramChannelAdapter(baseConfig);
      await expect(adapter.connect()).rejects.toThrow("Connection failed for telegram");
    });

    it("should be idempotent (no-op on double connect)", async () => {
      mockApiFetch.mockImplementation(async (url: string) => {
        if (url.toString().includes("getMe")) return mockGetMeResponse();
        return mockGetUpdatesResponse([]);
      });

      adapter = new TelegramChannelAdapter(baseConfig);
      await adapter.connect();
      await adapter.connect(); // should not throw
      expect(adapter.state).toBe("connected");
    });
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────

  describe("disconnect", () => {
    it("should disconnect cleanly", async () => {
      mockApiFetch.mockImplementation(async (url: string) => {
        if (url.toString().includes("getMe")) return mockGetMeResponse();
        return mockGetUpdatesResponse([]);
      });

      adapter = new TelegramChannelAdapter(baseConfig);
      await adapter.connect();
      await adapter.disconnect();
      expect(adapter.state).toBe("disconnected");
    });

    it("should be safe to disconnect when not connected", async () => {
      adapter = new TelegramChannelAdapter(baseConfig);
      await adapter.disconnect();
      expect(adapter.state).toBe("disconnected");
    });
  });

  // ── Send Message ───────────────────────────────────────────────────────────

  describe("sendMessage", () => {
    it("should throw if not connected", async () => {
      adapter = new TelegramChannelAdapter(baseConfig);
      await expect(adapter.sendMessage({
        content: "hello",
        channelOptions: { chatId: 100 },
      })).rejects.toThrow("not connected");
    });

    it("should throw if chatId is missing", async () => {
      mockApiFetch.mockImplementation(async (url: string) => {
        if (url.toString().includes("getMe")) return mockGetMeResponse();
        return mockGetUpdatesResponse([]);
      });

      adapter = new TelegramChannelAdapter(baseConfig);
      await adapter.connect();

      await expect(adapter.sendMessage({
        content: "hello",
      })).rejects.toThrow("chatId is required");
    });

    it("should send text message successfully", async () => {
      mockApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        const urlStr = url.toString();
        if (urlStr.includes("getMe")) return mockGetMeResponse();
        if (urlStr.includes("getUpdates")) return mockGetUpdatesResponse([]);
        if (urlStr.includes("sendMessage")) return mockSendMessageResponse();
        return { ok: true, json: () => Promise.resolve({ ok: true, result: {} }) };
      });

      adapter = new TelegramChannelAdapter(baseConfig);
      await adapter.connect();

      const msg = await adapter.sendMessage({
        content: "Hello from bot",
        channelOptions: { chatId: 100, parseMode: "HTML" },
      });

      expect(msg.id).toBe("42");
      expect(msg.channelType).toBe("telegram");
      expect(msg.content).toBe("Hello from bot");
      expect(msg.senderId).toBe("bot");
    });

    it("should send photo message when image attachment present", async () => {
      mockApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        const urlStr = url.toString();
        if (urlStr.includes("getMe")) return mockGetMeResponse();
        if (urlStr.includes("getUpdates")) return mockGetUpdatesResponse([]);
        if (urlStr.includes("sendPhoto")) return mockSendPhotoResponse();
        return { ok: true, json: () => Promise.resolve({ ok: true, result: {} }) };
      });

      adapter = new TelegramChannelAdapter(baseConfig);
      await adapter.connect();

      const msg = await adapter.sendMessage({
        content: "Check this out",
        attachments: [{ type: "image", url: "https://example.com/photo.jpg" }],
        channelOptions: { chatId: 100 },
      });

      expect(msg.id).toBe("43");
    });

    it("should include replyTo when specified", async () => {
      mockApiFetch.mockImplementation(async (url: string) => {
        const urlStr = url.toString();
        if (urlStr.includes("getMe")) return mockGetMeResponse();
        if (urlStr.includes("getUpdates")) return mockGetUpdatesResponse([]);
        if (urlStr.includes("sendMessage")) return mockSendMessageResponse(44);
        return { ok: true, json: () => Promise.resolve({ ok: true, result: {} }) };
      });

      adapter = new TelegramChannelAdapter(baseConfig);
      await adapter.connect();

      const msg = await adapter.sendMessage({
        content: "reply",
        replyTo: "10",
        channelOptions: { chatId: 100 },
      });

      expect(msg.replyTo).toBe("10");
    });
  });

  // ── Message Callbacks ──────────────────────────────────────────────────────

  describe("onMessage", () => {
    it("should register and unregister callbacks", () => {
      adapter = new TelegramChannelAdapter(baseConfig);
      const cb = vi.fn();
      const unsubscribe = adapter.onMessage(cb);

      // Unsubscribe should remove the callback
      unsubscribe();
      expect(typeof unsubscribe).toBe("function");
    });
  });

  // ── Status ─────────────────────────────────────────────────────────────────

  describe("getStatus", () => {
    it("should report disconnected state initially", () => {
      adapter = new TelegramChannelAdapter(baseConfig);
      const status = adapter.getStatus();
      expect(status.state).toBe("disconnected");
      expect(status.sentCount).toBe(0);
      expect(status.receivedCount).toBe(0);
    });
  });

  // ── History ────────────────────────────────────────────────────────────────

  describe("getHistory", () => {
    it("should return empty history initially", async () => {
      adapter = new TelegramChannelAdapter(baseConfig);
      const history = await adapter.getHistory();
      expect(history).toEqual([]);
    });

    it("should filter by limit", async () => {
      adapter = new TelegramChannelAdapter(baseConfig);
      // Manually add to history via sending
      mockApiFetch.mockImplementation(async (url: string) => {
        const urlStr = url.toString();
        if (urlStr.includes("getMe")) return mockGetMeResponse();
        if (urlStr.includes("getUpdates")) return mockGetUpdatesResponse([]);
        if (urlStr.includes("sendMessage")) return mockSendMessageResponse();
        return { ok: true, json: () => Promise.resolve({ ok: true, result: {} }) };
      });

      await adapter.connect();
      await adapter.sendMessage({ content: "msg1", channelOptions: { chatId: 100 } });
      await adapter.sendMessage({ content: "msg2", channelOptions: { chatId: 100 } });
      await adapter.sendMessage({ content: "msg3", channelOptions: { chatId: 100 } });

      const limited = await adapter.getHistory({ limit: 2 });
      expect(limited).toHaveLength(2);
    });
  });
});
