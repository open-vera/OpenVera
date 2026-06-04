/**
 * WeCom channel tests — lifecycle
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { WeComChannelAdapter } from "../wecom-channel.js";
import {
  baseConfig,
  mockApiFetch,
  mockTokenResponse,
  mockSendMessageResponse,
  originalFetch,
} from "./wecom-test-helpers.js";

describe("WeComChannelAdapter — lifecycle", () => {
  let adapter: WeComChannelAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockApiFetch.mockResolvedValue(mockTokenResponse());
  });

  afterEach(async () => {
    if (adapter && adapter.state !== "disconnected") {
      await adapter.disconnect();
    }
  });

  describe("constructor", () => {
    it("should require corpId", () => {
      expect(() => new WeComChannelAdapter({
        ...baseConfig,
        corpId: "",
      })).toThrow("corpId is required");
    });

    it("should require corpSecret", () => {
      expect(() => new WeComChannelAdapter({
        ...baseConfig,
        corpSecret: "",
      })).toThrow("corpSecret is required");
    });

    it("should require agentId", () => {
      expect(() => new WeComChannelAdapter({
        ...baseConfig,
        agentId: 0,
      })).toThrow("agentId is required");
    });

    it("should require token", () => {
      expect(() => new WeComChannelAdapter({
        ...baseConfig,
        token: "",
      })).toThrow("token is required");
    });

    it("should require encodingAesKey", () => {
      expect(() => new WeComChannelAdapter({
        ...baseConfig,
        encodingAesKey: "",
      })).toThrow("encodingAesKey is required");
    });

    it("should require encodingAesKey to be 43 characters", () => {
      expect(() => new WeComChannelAdapter({
        ...baseConfig,
        encodingAesKey: "short",
      })).toThrow("43 characters");
    });

    it("should create adapter with valid config", () => {
      adapter = new WeComChannelAdapter(baseConfig);
      expect(adapter.name).toBe("wecom");
      expect(adapter.channelType).toBe("wecom");
      expect(adapter.state).toBe("disconnected");
    });
  });

  // ── Connection Lifecycle ───────────────────────────────────────────────────

  describe("connect / disconnect", () => {
    it("should connect and validate credentials", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      await adapter.connect();

      expect(adapter.state).toBe("connected");
      expect(adapter.port).toBeGreaterThan(0);
      expect(mockApiFetch).toHaveBeenCalledWith(
        expect.stringContaining("/cgi-bin/gettoken"),
        expect.anything(),
      );
    });

    it("should fail to connect with invalid credentials", async () => {
      mockApiFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ errcode: 40013, errmsg: "invalid corp_id" }),
      });

      adapter = new WeComChannelAdapter(baseConfig);
      await expect(adapter.connect()).rejects.toThrow("Failed to obtain access_token");
      expect(adapter.state).toBe("error");
    });

    it("should disconnect cleanly", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      await adapter.connect();
      expect(adapter.state).toBe("connected");

      await adapter.disconnect();
      expect(adapter.state).toBe("disconnected");
    });
  });

  // ── Webhook Event Handling ─────────────────────────────────────────────────


  describe("token management", () => {
    it("should cache token and not re-fetch while valid", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      await adapter.connect();

      mockApiFetch.mockResolvedValueOnce(mockSendMessageResponse());
      await adapter.sendMessage({ content: "msg 1" });

      mockApiFetch.mockResolvedValueOnce(mockSendMessageResponse());
      await adapter.sendMessage({ content: "msg 2" });

      const tokenCalls = mockApiFetch.mock.calls.filter(
        (call: unknown[]) => (call[0] as string).includes("/cgi-bin/gettoken"),
      );
      expect(tokenCalls).toHaveLength(1);
    });
  });

  // ── History & Status ───────────────────────────────────────────────────────


  describe("history and status", () => {
    it("should track message history", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      await adapter.connect();

      const port = adapter.port;
      const xml = `<xml>
        <ToUserName><![CDATA[corpid]]></ToUserName>
        <FromUserName><![CDATA[user-hist]]></FromUserName>
        <CreateTime>1348831860</CreateTime>
        <MsgType><![CDATA[text]]></MsgType>
        <Content><![CDATA[history test]]></Content>
        <MsgId>hist-msg-001</MsgId>
        <AgentID>1000002</AgentID>
      </xml>`;

      await originalFetch(`http://localhost:${port}/wecom/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: xml,
      });

      await new Promise((r) => setTimeout(r, 100));

      const history = await adapter.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].content).toBe("history test");
    });

    it("should filter history by senderId", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      await adapter.connect();

      const port = adapter.port;

      // First message from user-a
      const xmlA = `<xml>
        <ToUserName><![CDATA[corpid]]></ToUserName>
        <FromUserName><![CDATA[user-a]]></FromUserName>
        <CreateTime>1348831860</CreateTime>
        <MsgType><![CDATA[text]]></MsgType>
        <Content><![CDATA[from user a]]></Content>
        <MsgId>hist-a-001</MsgId>
        <AgentID>1000002</AgentID>
      </xml>`;

      await originalFetch(`http://localhost:${port}/wecom/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: xmlA,
      });

      // Second message from user-b
      const xmlB = `<xml>
        <ToUserName><![CDATA[corpid]]></ToUserName>
        <FromUserName><![CDATA[user-b]]></FromUserName>
        <CreateTime>1348831861</CreateTime>
        <MsgType><![CDATA[text]]></MsgType>
        <Content><![CDATA[from user b]]></Content>
        <MsgId>hist-b-001</MsgId>
        <AgentID>1000002</AgentID>
      </xml>`;

      await originalFetch(`http://localhost:${port}/wecom/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: xmlB,
      });

      await new Promise((r) => setTimeout(r, 100));

      const historyA = await adapter.getHistory({ senderId: "user-a" });
      expect(historyA).toHaveLength(1);
      expect(historyA[0].content).toBe("from user a");

      const allHistory = await adapter.getHistory();
      expect(allHistory).toHaveLength(2);
    });

    it("should report correct status", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      await adapter.connect();

      const status = adapter.getStatus();
      expect(status.state).toBe("connected");
      expect(status.sentCount).toBe(0);
      expect(status.receivedCount).toBe(0);
      expect(status.message).toContain("WeCom bot");
    });

    it("should track sent and received counts", async () => {
      mockApiFetch
        .mockResolvedValueOnce(mockTokenResponse())
        .mockResolvedValueOnce(mockSendMessageResponse());

      adapter = new WeComChannelAdapter(baseConfig);
      await adapter.connect();

      // Send a message
      await adapter.sendMessage({ content: "sent msg" });

      // Receive a message
      const port = adapter.port;
      const xml = `<xml>
        <ToUserName><![CDATA[corpid]]></ToUserName>
        <FromUserName><![CDATA[user-count]]></FromUserName>
        <CreateTime>1348831860</CreateTime>
        <MsgType><![CDATA[text]]></MsgType>
        <Content><![CDATA[received msg]]></Content>
        <MsgId>count-msg-001</MsgId>
        <AgentID>1000002</AgentID>
      </xml>`;

      await originalFetch(`http://localhost:${port}/wecom/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: xml,
      });

      await new Promise((r) => setTimeout(r, 100));

      const status = adapter.getStatus();
      expect(status.sentCount).toBe(1);
      expect(status.receivedCount).toBe(1);
    });
  });

  // ── onMessage callback management ──────────────────────────────────────────


  describe("connection edge cases", () => {
    it("should be no-op when connect called while already connected", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      await adapter.connect();
      expect(adapter.state).toBe("connected");

      // Connect again — should be a no-op
      await adapter.connect();
      expect(adapter.state).toBe("connected");

      // Token should only be fetched once (from connect)
      // The second connect() returned early without fetching
    });

    it("should disconnect without server (never connected)", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      // Never called connect()
      await adapter.disconnect();
      expect(adapter.state).toBe("disconnected");
    });

    it("should handle server error during connect", async () => {
      // Use port 0 but mock the server to fail
      adapter = new WeComChannelAdapter({ ...baseConfig, port: -1 });
      mockApiFetch.mockResolvedValueOnce(mockTokenResponse());

      // Invalid port should cause EINVAL
      await expect(adapter.connect()).rejects.toThrow();
      // State should be set to error or connecting
    });

    it("should reconnect successfully after disconnect", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      await adapter.connect();
      await adapter.disconnect();

      // Second mock for token on reconnect
      mockApiFetch.mockResolvedValueOnce(mockTokenResponse("new-token"));
      await adapter.connect();
      expect(adapter.state).toBe("connected");
    });
  });

  // ── Token Edge Cases ────────────────────────────────────────────────────────

  describe("token edge cases", () => {
    it("should refresh token when expired", async () => {
      mockApiFetch
        .mockResolvedValueOnce(mockTokenResponse("token1", -1)) // -1 = negative expiry
        .mockResolvedValueOnce(mockSendMessageResponse())
        .mockResolvedValueOnce(mockTokenResponse("token2", 7200))
        .mockResolvedValueOnce(mockSendMessageResponse());

      adapter = new WeComChannelAdapter(baseConfig);
      await adapter.connect();

      // First sendMessage — token is expired, should refresh
      await adapter.sendMessage({ content: "msg1" });
      await adapter.sendMessage({ content: "msg2" });

      // Should have fetched token twice (once on connect, once because it expired)
      const tokenCalls = mockApiFetch.mock.calls.filter(
        (call: unknown[]) => (call[0] as string).includes("/cgi-bin/gettoken"),
      );
      // At least 2 token fetches: connect + refresh
      expect(tokenCalls.length).toBeGreaterThanOrEqual(2);
    });

    it("should deduplicate concurrent token refresh requests", async () => {
      mockApiFetch
        .mockResolvedValueOnce(mockTokenResponse("token1", -1)) // expired
        .mockResolvedValueOnce(mockTokenResponse("token2", 7200)) // single refresh
        .mockResolvedValueOnce(mockSendMessageResponse())
        .mockResolvedValueOnce(mockSendMessageResponse());

      adapter = new WeComChannelAdapter(baseConfig);
      await adapter.connect();

      // Send two messages concurrently — both should share one token refresh
      await Promise.all([
        adapter.sendMessage({ content: "concurrent-1" }),
        adapter.sendMessage({ content: "concurrent-2" }),
      ]);

      const tokenCalls = mockApiFetch.mock.calls.filter(
        (call: unknown[]) => (call[0] as string).includes("/cgi-bin/gettoken"),
      );
      expect(tokenCalls).toHaveLength(2); // connect + one refresh (shared)
    });
  });

  // ── Additional Event Types ──────────────────────────────────────────────────


});
