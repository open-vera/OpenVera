/**
 * WeCom (企业微信) Channel Adapter Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WeComChannelAdapter } from "../wecom-channel.js";

// ── Selective fetch mock — only intercepts WeCom API calls ─────────────────────

const originalFetch = globalThis.fetch;
const mockApiFetch = vi.fn();

function mockTokenResponse(token = "test-access-token", expiresIn = 7200) {
  return {
    ok: true,
    json: () => Promise.resolve({
      errcode: 0,
      errmsg: "ok",
      access_token: token,
      expires_in: expiresIn,
    }),
  };
}

function mockSendMessageResponse() {
  return {
    ok: true,
    json: () => Promise.resolve({
      errcode: 0,
      errmsg: "ok",
    }),
  };
}

// Override fetch to route: WeCom API → mock, localhost → real
vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
  const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
  if (urlStr.includes("qyapi.weixin.qq.com") || urlStr.includes("/cgi-bin/")) {
    return mockApiFetch(url, init);
  }
  return originalFetch(url, init);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("WeComChannelAdapter", () => {
  const baseConfig = {
    corpId: "test-corp-id",
    corpSecret: "test-corp-secret",
    agentId: 1000002,
    token: "test-token",
    encodingAesKey: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG", // 43 chars
  };

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

  // ── Construction ───────────────────────────────────────────────────────────

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

  describe("webhook events", () => {
    it("should return 404 for wrong path", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      await adapter.connect();

      const port = adapter.port;
      const resp = await originalFetch(`http://localhost:${port}/wrong/path`, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: "<xml></xml>",
      });

      expect(resp.status).toBe(404);
    });

    it("should handle unencrypted text message", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      const messages: unknown[] = [];
      adapter.onMessage((msg) => { messages.push(msg); });
      await adapter.connect();

      const port = adapter.port;
      const xml = `<xml>
        <ToUserName><![CDATA[corpid]]></ToUserName>
        <FromUserName><![CDATA[user123]]></FromUserName>
        <CreateTime>1348831860</CreateTime>
        <MsgType><![CDATA[text]]></MsgType>
        <Content><![CDATA[Hello WeCom]]></Content>
        <MsgId>1234567890123456</MsgId>
        <AgentID>1000002</AgentID>
      </xml>`;

      const resp = await originalFetch(`http://localhost:${port}/wecom/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: xml,
      });

      expect(resp.status).toBe(200);
      await new Promise((r) => setTimeout(r, 100));

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        id: "1234567890123456",
        channelType: "wecom",
        senderId: "user123",
        content: "Hello WeCom",
      });
    });

    it("should handle unencrypted image message", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      const messages: unknown[] = [];
      adapter.onMessage((msg) => { messages.push(msg); });
      await adapter.connect();

      const port = adapter.port;
      const xml = `<xml>
        <ToUserName><![CDATA[corpid]]></ToUserName>
        <FromUserName><![CDATA[user-img]]></FromUserName>
        <CreateTime>1348831860</CreateTime>
        <MsgType><![CDATA[image]]></MsgType>
        <PicUrl><![CDATA[https://example.com/pic.jpg]]></PicUrl>
        <MediaId><![CDATA[media-abc-123]]></MediaId>
        <MsgId>img-msg-001</MsgId>
        <AgentID>1000002</AgentID>
      </xml>`;

      await originalFetch(`http://localhost:${port}/wecom/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: xml,
      });

      await new Promise((r) => setTimeout(r, 100));

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        content: "[image]",
        attachments: [{ type: "image", url: "https://example.com/pic.jpg" }],
      });
    });

    it("should handle unencrypted voice message with recognition", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      const messages: unknown[] = [];
      adapter.onMessage((msg) => { messages.push(msg); });
      await adapter.connect();

      const port = adapter.port;
      const xml = `<xml>
        <ToUserName><![CDATA[corpid]]></ToUserName>
        <FromUserName><![CDATA[user-voice]]></FromUserName>
        <CreateTime>1348831860</CreateTime>
        <MsgType><![CDATA[voice]]></MsgType>
        <MediaId><![CDATA[voice-media-001]]></MediaId>
        <Format><![CDATA[amr]]></Format>
        <Recognition><![CDATA[recognized text]]></Recognition>
        <MsgId>voice-msg-001</MsgId>
        <AgentID>1000002</AgentID>
      </xml>`;

      await originalFetch(`http://localhost:${port}/wecom/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: xml,
      });

      await new Promise((r) => setTimeout(r, 100));

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        content: "recognized text",
      });
    });

    it("should handle unencrypted voice message without recognition", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      const messages: unknown[] = [];
      adapter.onMessage((msg) => { messages.push(msg); });
      await adapter.connect();

      const port = adapter.port;
      const xml = `<xml>
        <ToUserName><![CDATA[corpid]]></ToUserName>
        <FromUserName><![CDATA[user-voice]]></FromUserName>
        <CreateTime>1348831860</CreateTime>
        <MsgType><![CDATA[voice]]></MsgType>
        <MediaId><![CDATA[voice-media-002]]></MediaId>
        <Format><![CDATA[amr]]></Format>
        <MsgId>voice-msg-002</MsgId>
        <AgentID>1000002</AgentID>
      </xml>`;

      await originalFetch(`http://localhost:${port}/wecom/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: xml,
      });

      await new Promise((r) => setTimeout(r, 100));

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        content: "[voice]",
      });
    });

    it("should handle unencrypted link message", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      const messages: unknown[] = [];
      adapter.onMessage((msg) => { messages.push(msg); });
      await adapter.connect();

      const port = adapter.port;
      const xml = `<xml>
        <ToUserName><![CDATA[corpid]]></ToUserName>
        <FromUserName><![CDATA[user-link]]></FromUserName>
        <CreateTime>1348831860</CreateTime>
        <MsgType><![CDATA[link]]></MsgType>
        <Title><![CDATA[Test Link]]></Title>
        <Description><![CDATA[A test link description]]></Description>
        <Url><![CDATA[https://example.com]]></Url>
        <MsgId>link-msg-001</MsgId>
        <AgentID>1000002</AgentID>
      </xml>`;

      await originalFetch(`http://localhost:${port}/wecom/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: xml,
      });

      await new Promise((r) => setTimeout(r, 100));

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        content: "Test Link\nA test link description",
        attachments: [{ type: "link", url: "https://example.com" }],
      });
    });

    it("should handle event messages", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      const messages: unknown[] = [];
      adapter.onMessage((msg) => { messages.push(msg); });
      await adapter.connect();

      const port = adapter.port;
      const xml = `<xml>
        <ToUserName><![CDATA[corpid]]></ToUserName>
        <FromUserName><![CDATA[user-event]]></FromUserName>
        <CreateTime>1348831860</CreateTime>
        <MsgType><![CDATA[event]]></MsgType>
        <Event><![CDATA[enter_agent]]></Event>
        <EventKey><![CDATA[]]></EventKey>
        <AgentID>1000002</AgentID>
      </xml>`;

      await originalFetch(`http://localhost:${port}/wecom/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: xml,
      });

      await new Promise((r) => setTimeout(r, 100));

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        content: "[event: enter_agent]",
      });
    });
  });

  // ── Send Message ───────────────────────────────────────────────────────────

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
});
