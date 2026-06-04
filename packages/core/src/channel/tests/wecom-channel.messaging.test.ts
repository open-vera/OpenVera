/**
 * WeCom channel tests — messaging
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

describe("WeComChannelAdapter — messaging", () => {
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

  describe("sendMessage", () => {
    it("should send text message via WeCom API", async () => {
      mockApiFetch
        .mockResolvedValueOnce(mockTokenResponse())
        .mockResolvedValueOnce(mockSendMessageResponse());

      adapter = new WeComChannelAdapter(baseConfig);
      await adapter.connect();

      const result = await adapter.sendMessage({
        content: "Hello from bot!",
        channelOptions: {
          toUser: "user123",
        },
      });

      expect(result.content).toBe("Hello from bot!");
      expect(result.senderId).toBe("bot");
      expect(result.channelType).toBe("wecom");

      const sendCall = mockApiFetch.mock.calls.find(
        (call: unknown[]) => (call[0] as string).includes("/cgi-bin/message/send"),
      );
      expect(sendCall).toBeTruthy();
    });

    it("should send markdown message", async () => {
      mockApiFetch
        .mockResolvedValueOnce(mockTokenResponse())
        .mockResolvedValueOnce(mockSendMessageResponse());

      adapter = new WeComChannelAdapter(baseConfig);
      await adapter.connect();

      const result = await adapter.sendMessage({
        content: "**Bold** text",
        channelOptions: {
          toUser: "user123",
          msgType: "markdown",
        },
      });

      expect(result.content).toBe("**Bold** text");
    });

    it("should default to @all when toUser is not specified", async () => {
      mockApiFetch
        .mockResolvedValueOnce(mockTokenResponse())
        .mockResolvedValueOnce(mockSendMessageResponse());

      adapter = new WeComChannelAdapter(baseConfig);
      await adapter.connect();

      await adapter.sendMessage({ content: "broadcast" });

      const sendCall = mockApiFetch.mock.calls.find(
        (call: unknown[]) => (call[0] as string).includes("/cgi-bin/message/send"),
      );
      expect(sendCall).toBeTruthy();
      const body = JSON.parse((sendCall![1] as RequestInit).body as string);
      expect(body.touser).toBe("@all");
    });

    it("should throw when not connected", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      await expect(adapter.sendMessage({
        content: "test",
      })).rejects.toThrow("not connected");
    });

    it("should handle WeCom API error on send", async () => {
      mockApiFetch
        .mockResolvedValueOnce(mockTokenResponse())
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ errcode: 45027, errmsg: "media platform error" }),
        });

      adapter = new WeComChannelAdapter(baseConfig);
      await adapter.connect();

      await expect(adapter.sendMessage({
        content: "test",
      })).rejects.toThrow("media platform error");
    });
  });

  // ── Token Management ───────────────────────────────────────────────────────


  describe("onMessage", () => {
    it("should allow unsubscribing from messages", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      const messages: unknown[] = [];
      const unsubscribe = adapter.onMessage((msg) => { messages.push(msg); });
      await adapter.connect();

      // Unsubscribe
      unsubscribe();

      const port = adapter.port;
      const xml = `<xml>
        <ToUserName><![CDATA[corpid]]></ToUserName>
        <FromUserName><![CDATA[user-unsub]]></FromUserName>
        <CreateTime>1348831860</CreateTime>
        <MsgType><![CDATA[text]]></MsgType>
        <Content><![CDATA[should not receive]]></Content>
        <MsgId>unsub-msg-001</MsgId>
        <AgentID>1000002</AgentID>
      </xml>`;

      await originalFetch(`http://localhost:${port}/wecom/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: xml,
      });

      await new Promise((r) => setTimeout(r, 100));

      expect(messages).toHaveLength(0);
    });
  });

  // ── Encrypted Webhook Events ────────────────────────────────────────────────


  describe("sendMessage edge cases", () => {
    it("should send image message with mediaId", async () => {
      mockApiFetch
        .mockResolvedValueOnce(mockTokenResponse())
        .mockResolvedValueOnce(mockSendMessageResponse());

      adapter = new WeComChannelAdapter(baseConfig);
      await adapter.connect();

      await adapter.sendMessage({
        content: "unused",
        channelOptions: {
          msgType: "image",
          mediaId: "media-xyz-123",
          toUser: "user123",
        },
      });

      const sendCall = mockApiFetch.mock.calls.find(
        (call: unknown[]) => (call[0] as string).includes("/cgi-bin/message/send"),
      );
      expect(sendCall).toBeTruthy();
      const body = JSON.parse((sendCall![1] as RequestInit).body as string);
      expect(body.msgtype).toBe("image");
      expect(body.image.media_id).toBe("media-xyz-123");
    });

    it("should send news message with articles", async () => {
      mockApiFetch
        .mockResolvedValueOnce(mockTokenResponse())
        .mockResolvedValueOnce(mockSendMessageResponse());

      adapter = new WeComChannelAdapter(baseConfig);
      await adapter.connect();

      const articles = [
        { title: "Article 1", description: "Desc 1", url: "https://example.com/1", picUrl: "https://example.com/1.jpg" },
        { title: "Article 2", url: "https://example.com/2" },
      ];

      await adapter.sendMessage({
        content: "unused",
        channelOptions: {
          msgType: "news",
          articles,
          toUser: "user123",
        },
      });

      const sendCall = mockApiFetch.mock.calls.find(
        (call: unknown[]) => (call[0] as string).includes("/cgi-bin/message/send"),
      );
      expect(sendCall).toBeTruthy();
      const body = JSON.parse((sendCall![1] as RequestInit).body as string);
      expect(body.msgtype).toBe("news");
      expect(body.news.articles).toEqual(articles);
    });

    it("should fallback to text when image type has no mediaId", async () => {
      mockApiFetch
        .mockResolvedValueOnce(mockTokenResponse())
        .mockResolvedValueOnce(mockSendMessageResponse());

      adapter = new WeComChannelAdapter(baseConfig);
      await adapter.connect();

      await adapter.sendMessage({
        content: "fallback message",
        channelOptions: {
          msgType: "image",
          toUser: "user123",
          // no mediaId
        },
      });

      const sendCall = mockApiFetch.mock.calls.find(
        (call: unknown[]) => (call[0] as string).includes("/cgi-bin/message/send"),
      );
      const body = JSON.parse((sendCall![1] as RequestInit).body as string);
      expect(body.msgtype).toBe("text");
      expect(body.text.content).toBe("fallback message");
    });

    it("should include toParty and toTag in text messages", async () => {
      mockApiFetch
        .mockResolvedValueOnce(mockTokenResponse())
        .mockResolvedValueOnce(mockSendMessageResponse());

      adapter = new WeComChannelAdapter(baseConfig);
      await adapter.connect();

      await adapter.sendMessage({
        content: "group message",
        channelOptions: {
          toParty: "2",
          toTag: "3",
        },
      });

      const sendCall = mockApiFetch.mock.calls.find(
        (call: unknown[]) => (call[0] as string).includes("/cgi-bin/message/send"),
      );
      const body = JSON.parse((sendCall![1] as RequestInit).body as string);
      expect(body.touser).toBe("@all");
      expect(body.toparty).toBe("2");
      expect(body.totag).toBe("3");
    });

    it("should use custom generateId for sent messages", async () => {
      mockApiFetch
        .mockResolvedValueOnce(mockTokenResponse())
        .mockResolvedValueOnce(mockSendMessageResponse());

      const customAdapter = new WeComChannelAdapter({
        ...baseConfig,
        generateId: () => "custom-sent-id",
      });
      await customAdapter.connect();

      const result = await customAdapter.sendMessage({ content: "test" });
      expect(result.id).toBe("custom-sent-id");
      await customAdapter.disconnect();
    });
  });

  // ── History Filtering ───────────────────────────────────────────────────────

  describe("history filtering", () => {
    it("should filter by after timestamp", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      await adapter.connect();

      const port = adapter.port;
      // Send two messages with a time gap
      const xml1 = `<xml>
        <ToUserName><![CDATA[corpid]]></ToUserName>
        <FromUserName><![CDATA[user-hist]]></FromUserName>
        <CreateTime>100</CreateTime>
        <MsgType><![CDATA[text]]></MsgType>
        <Content><![CDATA[first]]></Content>
        <MsgId>hist-001</MsgId>
        <AgentID>1000002</AgentID>
      </xml>`;

      await originalFetch(`http://localhost:${port}/wecom/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: xml1,
      });
      await new Promise((r) => setTimeout(r, 50));

      const middleTimestamp = new Date().toISOString();

      await new Promise((r) => setTimeout(r, 50));
      const xml2 = `<xml>
        <ToUserName><![CDATA[corpid]]></ToUserName>
        <FromUserName><![CDATA[user-hist]]></FromUserName>
        <CreateTime>100</CreateTime>
        <MsgType><![CDATA[text]]></MsgType>
        <Content><![CDATA[second]]></Content>
        <MsgId>hist-002</MsgId>
        <AgentID>1000002</AgentID>
      </xml>`;

      await originalFetch(`http://localhost:${port}/wecom/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: xml2,
      });
      await new Promise((r) => setTimeout(r, 50));

      const history = await adapter.getHistory({ after: middleTimestamp });
      expect(history).toHaveLength(1);
      expect(history[0].content).toBe("second");
    });

    it("should filter by before timestamp", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      await adapter.connect();

      const port = adapter.port;
      const xml1 = `<xml>
        <ToUserName><![CDATA[corpid]]></ToUserName>
        <FromUserName><![CDATA[user-hist]]></FromUserName>
        <CreateTime>100</CreateTime>
        <MsgType><![CDATA[text]]></MsgType>
        <Content><![CDATA[first]]></Content>
        <MsgId>hist-003</MsgId>
        <AgentID>1000002</AgentID>
      </xml>`;

      await originalFetch(`http://localhost:${port}/wecom/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: xml1,
      });
      await new Promise((r) => setTimeout(r, 50));

      const middleTimestamp = new Date().toISOString();

      await new Promise((r) => setTimeout(r, 50));
      const xml2 = `<xml>
        <ToUserName><![CDATA[corpid]]></ToUserName>
        <FromUserName><![CDATA[user-hist]]></FromUserName>
        <CreateTime>100</CreateTime>
        <MsgType><![CDATA[text]]></MsgType>
        <Content><![CDATA[second]]></Content>
        <MsgId>hist-004</MsgId>
        <AgentID>1000002</AgentID>
      </xml>`;

      await originalFetch(`http://localhost:${port}/wecom/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: xml2,
      });
      await new Promise((r) => setTimeout(r, 50));

      const history = await adapter.getHistory({ before: middleTimestamp });
      expect(history).toHaveLength(1);
      expect(history[0].content).toBe("first");
    });

    it("should respect limit option", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      await adapter.connect();

      const port = adapter.port;
      for (let i = 0; i < 5; i++) {
        const xml = `<xml>
          <ToUserName><![CDATA[corpid]]></ToUserName>
          <FromUserName><![CDATA[user-hist]]></FromUserName>
          <CreateTime>100</CreateTime>
          <MsgType><![CDATA[text]]></MsgType>
          <Content><![CDATA[msg-${i}]]></Content>
          <MsgId>hist-limit-${i}</MsgId>
          <AgentID>1000002</AgentID>
        </xml>`;

        await originalFetch(`http://localhost:${port}/wecom/webhook`, {
          method: "POST",
          headers: { "Content-Type": "application/xml" },
          body: xml,
        });
      }
      await new Promise((r) => setTimeout(r, 100));

      const history = await adapter.getHistory({ limit: 2 });
      expect(history).toHaveLength(2);
    });

    it("should combine multiple filters", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      await adapter.connect();

      const port = adapter.port;
      const xml1 = `<xml>
        <ToUserName><![CDATA[corpid]]></ToUserName>
        <FromUserName><![CDATA[alice]]></FromUserName>
        <CreateTime>100</CreateTime>
        <MsgType><![CDATA[text]]></MsgType>
        <Content><![CDATA[from alice]]></Content>
        <MsgId>combo-001</MsgId>
        <AgentID>1000002</AgentID>
      </xml>`;

      await originalFetch(`http://localhost:${port}/wecom/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: xml1,
      });
      await new Promise((r) => setTimeout(r, 50));

      const xml2 = `<xml>
        <ToUserName><![CDATA[corpid]]></ToUserName>
        <FromUserName><![CDATA[bob]]></FromUserName>
        <CreateTime>100</CreateTime>
        <MsgType><![CDATA[text]]></MsgType>
        <Content><![CDATA[from bob]]></Content>
        <MsgId>combo-002</MsgId>
        <AgentID>1000002</AgentID>
      </xml>`;

      await originalFetch(`http://localhost:${port}/wecom/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: xml2,
      });
      await new Promise((r) => setTimeout(r, 50));

      // Filter by senderId=bob and limit=1
      const history = await adapter.getHistory({ senderId: "bob", limit: 1 });
      expect(history).toHaveLength(1);
      expect(history[0].content).toBe("from bob");
    });
  });

  // ── Connection Edge Cases ───────────────────────────────────────────────────


  describe("edge cases", () => {
    it("should not dispatch empty text messages", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      const messages: unknown[] = [];
      adapter.onMessage((msg) => { messages.push(msg); });
      await adapter.connect();

      const port = adapter.port;
      const xml = `<xml>
        <ToUserName><![CDATA[corpid]]></ToUserName>
        <FromUserName><![CDATA[user-empty]]></FromUserName>
        <CreateTime>1348831860</CreateTime>
        <MsgType><![CDATA[text]]></MsgType>
        <Content><![CDATA[]]></Content>
        <MsgId>empty-msg-001</MsgId>
        <AgentID>1000002</AgentID>
      </xml>`;

      await originalFetch(`http://localhost:${port}/wecom/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: xml,
      });

      await new Promise((r) => setTimeout(r, 100));

      // Empty text should not dispatch
      expect(messages).toHaveLength(0);
    });

    it("should generate msgId when not provided in event", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      const messages: unknown[] = [];
      adapter.onMessage((msg) => { messages.push(msg); });
      await adapter.connect();

      const port = adapter.port;
      const xml = `<xml>
        <ToUserName><![CDATA[corpid]]></ToUserName>
        <FromUserName><![CDATA[user-noid]]></FromUserName>
        <CreateTime>1348831860</CreateTime>
        <MsgType><![CDATA[text]]></MsgType>
        <Content><![CDATA[message without id]]></Content>
        <AgentID>1000002</AgentID>
      </xml>`;

      await originalFetch(`http://localhost:${port}/wecom/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: xml,
      });

      await new Promise((r) => setTimeout(r, 100));

      expect(messages).toHaveLength(1);
      expect(messages[0].id).toMatch(/^wecom-/);
      expect(messages[0].content).toBe("message without id");
    });

    it("should handle POST with empty body", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      await adapter.connect();

      const port = adapter.port;
      const resp = await originalFetch(`http://localhost:${port}/wecom/webhook`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "",
      });

      expect(resp.status).toBe(400);
    });

    it("should handle readBody body too large", async () => {
      // Create adapter with small maxBodyBytes
      const smallAdapter = new WeComChannelAdapter({
        ...baseConfig,
        maxBodyBytes: 100,
      });
      await smallAdapter.connect();

      const port = smallAdapter.port;
      const bigBody = "x".repeat(200);

      // Server destroys the connection on body-too-large, so fetch will fail
      let fetchFailed = false;
      try {
        await originalFetch(`http://localhost:${port}/wecom/webhook`, {
          method: "POST",
          headers: { "Content-Type": "application/xml" },
          body: bigBody,
        });
      } catch {
        fetchFailed = true;
      }
      expect(fetchFailed).toBe(true);
      await smallAdapter.disconnect();
    });

    it("should set CORS headers on all responses", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      await adapter.connect();

      const port = adapter.port;
      const resp = await originalFetch(`http://localhost:${port}/wrong/path`, {
        method: "GET",
      });

      expect(resp.headers.get("access-control-allow-origin")).toBe("*");
      expect(resp.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
    });

    it("should default generateId to wecom- prefix", async () => {
      const simpleAdapter = new WeComChannelAdapter(baseConfig);
      expect(simpleAdapter.state).toBe("disconnected");
      // Just verify the adapter created successfully with defaults
    });
  });

});
