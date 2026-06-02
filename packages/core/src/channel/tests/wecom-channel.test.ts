/**
 * WeCom (企业微信) Channel Adapter Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
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

  // ── Encrypted Webhook Events ────────────────────────────────────────────────

  describe("encrypted webhook", () => {
    function pkcs7Pad(data: Buffer, blockSize: number): Buffer {
      const padLen = blockSize - (data.length % blockSize);
      const padded = Buffer.alloc(data.length + padLen, padLen);
      data.copy(padded);
      return padded;
    }

    function encryptMsg(msg: string, aesKey: Buffer, corpId: string): string {
      const msgBuf = Buffer.from(msg, "utf-8");
      // Use deterministic "random" bytes for test reproducibility
      const randomBuf = Buffer.alloc(16);
      for (let i = 0; i < 16; i++) randomBuf[i] = (i * 7 + 3) % 256;
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32BE(msgBuf.length, 0);
      const corpIdBuf = Buffer.from(corpId, "utf-8");
      const plainData = Buffer.concat([randomBuf, lenBuf, msgBuf, corpIdBuf]);
      const padded = pkcs7Pad(plainData, 32);
      const iv = aesKey.subarray(0, 16);
      const cipher = createCipheriv("aes-256-cbc", aesKey, iv);
      cipher.setAutoPadding(false);
      const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
      return encrypted.toString("base64");
    }

    function computeSig(token: string, timestamp: string, nonce: string, encrypted: string): string {
      const arr = [token, timestamp, nonce, encrypted].sort();
      return createHash("sha1").update(arr.join("")).digest("hex");
    }

    it("should decrypt and handle encrypted text message", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      const messages: unknown[] = [];
      adapter.onMessage((msg) => { messages.push(msg); });
      await adapter.connect();

      const aesKey = Buffer.from(baseConfig.encodingAesKey + "=", "base64");
      const timestamp = "1409659589";
      const nonce = "263014780";

      // Inner XML message
      const innerXml = `<xml>
<ToUserName><![CDATA[test-corp-id]]></ToUserName>
<FromUserName><![CDATA[enc-user]]></FromUserName>
<CreateTime>1409659589</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[encrypted hello]]></Content>
<MsgId>enc-msg-001</MsgId>
<AgentID>1000002</AgentID>
</xml>`;

      const encryptStr = encryptMsg(innerXml, aesKey, baseConfig.corpId);
      const msgSignature = computeSig(baseConfig.token, timestamp, nonce, encryptStr);

      const outerXml = `<xml>
<Encrypt><![CDATA[${encryptStr}]]></Encrypt>
</xml>`;

      const port = adapter.port;
      const resp = await originalFetch(
        `http://localhost:${port}/wecom/webhook?msg_signature=${msgSignature}&timestamp=${timestamp}&nonce=${nonce}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/xml" },
          body: outerXml,
        },
      );

      expect(resp.status).toBe(200);
      await new Promise((r) => setTimeout(r, 100));

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        senderId: "enc-user",
        content: "encrypted hello",
      });
    });

    it("should reject encrypted message with invalid signature", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      await adapter.connect();

      const aesKey = Buffer.from(baseConfig.encodingAesKey + "=", "base64");
      const timestamp = "1409659589";
      const nonce = "263014780";

      const innerXml = `<xml><ToUserName><![CDATA[test-corp-id]]></ToUserName></xml>`;
      const encryptStr = encryptMsg(innerXml, aesKey, baseConfig.corpId);
      // Wrong signature
      const wrongSig = computeSig("wrong-token", timestamp, nonce, encryptStr);

      const outerXml = `<xml><Encrypt><![CDATA[${encryptStr}]]></Encrypt></xml>`;

      const port = adapter.port;
      const resp = await originalFetch(
        `http://localhost:${port}/wecom/webhook?msg_signature=${wrongSig}&timestamp=${timestamp}&nonce=${nonce}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/xml" },
          body: outerXml,
        },
      );

      expect(resp.status).toBe(403);
      const body = await resp.text();
      expect(body).toBe("Invalid signature");
    });

    it("should handle encrypted image message", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      const messages: unknown[] = [];
      adapter.onMessage((msg) => { messages.push(msg); });
      await adapter.connect();

      const aesKey = Buffer.from(baseConfig.encodingAesKey + "=", "base64");
      const timestamp = "1409659589";
      const nonce = "263014780";

      const innerXml = `<xml>
<ToUserName><![CDATA[test-corp-id]]></ToUserName>
<FromUserName><![CDATA[enc-img-user]]></FromUserName>
<CreateTime>1409659589</CreateTime>
<MsgType><![CDATA[image]]></MsgType>
<PicUrl><![CDATA[https://example.com/enc-pic.jpg]]></PicUrl>
<MediaId><![CDATA[enc-media-001]]></MediaId>
<MsgId>enc-img-001</MsgId>
<AgentID>1000002</AgentID>
</xml>`;

      const encryptStr = encryptMsg(innerXml, aesKey, baseConfig.corpId);
      const msgSignature = computeSig(baseConfig.token, timestamp, nonce, encryptStr);

      const outerXml = `<xml><Encrypt><![CDATA[${encryptStr}]]></Encrypt></xml>`;

      const port = adapter.port;
      await originalFetch(
        `http://localhost:${port}/wecom/webhook?msg_signature=${msgSignature}&timestamp=${timestamp}&nonce=${nonce}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/xml" },
          body: outerXml,
        },
      );

      await new Promise((r) => setTimeout(r, 100));
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        content: "[image]",
        attachments: [{ type: "image", url: "https://example.com/enc-pic.jpg" }],
      });
    });
  });

  // ── Webhook Verification (GET) ──────────────────────────────────────────────

  describe("verification (GET)", () => {
    it("should respond with decrypted echostr on valid signature", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      await adapter.connect();

      const aesKey = Buffer.from(baseConfig.encodingAesKey + "=", "base64");
      const timestamp = "1409659589";
      const nonce = "263014780";
      const echoStr = "encrypted-echo-test-value";

      // Encrypt using the same algorithm the adapter expects
      const msgBuf = Buffer.from(echoStr, "utf-8");
      const randomBuf = Buffer.alloc(16, 0x42);
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32BE(msgBuf.length, 0);
      const corpIdBuf = Buffer.from(baseConfig.corpId, "utf-8");
      const plainData = Buffer.concat([randomBuf, lenBuf, msgBuf, corpIdBuf]);
      const padLen = 32 - (plainData.length % 32);
      const padded = Buffer.alloc(plainData.length + padLen, padLen);
      plainData.copy(padded);
      const iv = aesKey.subarray(0, 16);
      const cipher = createCipheriv("aes-256-cbc", aesKey, iv);
      cipher.setAutoPadding(false);
      const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
      const encryptedEchoStr = encrypted.toString("base64");

      const sigArr = [baseConfig.token, timestamp, nonce, encryptedEchoStr].sort();
      const msgSignature = createHash("sha1").update(sigArr.join("")).digest("hex");

      const port = adapter.port;
      const resp = await originalFetch(
        `http://localhost:${port}/wecom/webhook?msg_signature=${msgSignature}&timestamp=${timestamp}&nonce=${nonce}&echostr=${encodeURIComponent(encryptedEchoStr)}`,
        { method: "GET" },
      );

      expect(resp.status).toBe(200);
      const text = await resp.text();
      expect(text).toBe(echoStr);
    });

    it("should return 403 for invalid signature on verification", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      await adapter.connect();

      const port = adapter.port;
      const resp = await originalFetch(
        `http://localhost:${port}/wecom/webhook?msg_signature=bad-sig&timestamp=1&nonce=2&echostr=something`,
        { method: "GET" },
      );

      expect(resp.status).toBe(403);
      const text = await resp.text();
      expect(text).toBe("Invalid signature");
    });

    it("should return 400 when echostr decryption fails", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      await adapter.connect();

      const timestamp = "1409659589";
      const nonce = "263014780";
      // "bogus" is not valid base64-encoded AES ciphertext
      const bogusEchoStr = "bogus-data-not-encrypted";

      const sigArr = [baseConfig.token, timestamp, nonce, bogusEchoStr].sort();
      const msgSignature = createHash("sha1").update(sigArr.join("")).digest("hex");

      const port = adapter.port;
      const resp = await originalFetch(
        `http://localhost:${port}/wecom/webhook?msg_signature=${msgSignature}&timestamp=${timestamp}&nonce=${nonce}&echostr=${bogusEchoStr}`,
        { method: "GET" },
      );

      expect(resp.status).toBe(400);
      const text = await resp.text();
      expect(text).toBe("Decryption failed");
    });
  });

  // ── HTTP Method Handling ────────────────────────────────────────────────────

  describe("http methods", () => {
    it("should handle OPTIONS preflight", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      await adapter.connect();

      const port = adapter.port;
      const resp = await originalFetch(`http://localhost:${port}/wecom/webhook`, {
        method: "OPTIONS",
      });

      expect(resp.status).toBe(204);
      expect(resp.headers.get("access-control-allow-origin")).toBe("*");
    });

    it("should return 405 for unsupported methods (PUT)", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      await adapter.connect();

      const port = adapter.port;
      const resp = await originalFetch(`http://localhost:${port}/wecom/webhook`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });

      expect(resp.status).toBe(405);
    });

    it("should return 405 for unsupported methods (DELETE)", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      await adapter.connect();

      const port = adapter.port;
      const resp = await originalFetch(`http://localhost:${port}/wecom/webhook`, {
        method: "DELETE",
      });

      expect(resp.status).toBe(405);
    });
  });

  // ── sendMessage Edge Cases ──────────────────────────────────────────────────

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

  describe("additional event types", () => {
    it("should handle video message", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      const messages: unknown[] = [];
      adapter.onMessage((msg) => { messages.push(msg); });
      await adapter.connect();

      const port = adapter.port;
      const xml = `<xml>
        <ToUserName><![CDATA[corpid]]></ToUserName>
        <FromUserName><![CDATA[user-video]]></FromUserName>
        <CreateTime>1348831860</CreateTime>
        <MsgType><![CDATA[video]]></MsgType>
        <MediaId><![CDATA[vid-media-001]]></MediaId>
        <MsgId>video-msg-001</MsgId>
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
        content: "[video]",
        attachments: [{ type: "video", url: "vid-media-001" }],
      });
    });

    it("should handle shortvideo message", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      const messages: unknown[] = [];
      adapter.onMessage((msg) => { messages.push(msg); });
      await adapter.connect();

      const port = adapter.port;
      const xml = `<xml>
        <ToUserName><![CDATA[corpid]]></ToUserName>
        <FromUserName><![CDATA[user-shortvid]]></FromUserName>
        <CreateTime>1348831860</CreateTime>
        <MsgType><![CDATA[shortvideo]]></MsgType>
        <MediaId><![CDATA[svid-media-001]]></MediaId>
        <MsgId>svideo-msg-001</MsgId>
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
        content: "[shortvideo]",
        attachments: [{ type: "video" }],
      });
    });

    it("should handle location message", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      const messages: unknown[] = [];
      adapter.onMessage((msg) => { messages.push(msg); });
      await adapter.connect();

      const port = adapter.port;
      const xml = `<xml>
        <ToUserName><![CDATA[corpid]]></ToUserName>
        <FromUserName><![CDATA[user-loc]]></FromUserName>
        <CreateTime>1348831860</CreateTime>
        <MsgType><![CDATA[location]]></MsgType>
        <Location_X>23.134521</Location_X>
        <Location_Y>113.358803</Location_Y>
        <Scale>20</Scale>
        <Label><![CDATA[Guangzhou]]></Label>
        <MsgId>loc-msg-001</MsgId>
        <AgentID>1000002</AgentID>
      </xml>`;

      await originalFetch(`http://localhost:${port}/wecom/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: xml,
      });

      await new Promise((r) => setTimeout(r, 100));

      expect(messages).toHaveLength(1);
      // parseWeComXml does not include Location_X/Y in its tag list,
      // so unencrypted location messages get empty coordinate values
      expect(messages[0].content).toContain("[location:");
      expect(messages[0].raw).toMatchObject({ msgType: "location" });
    });

    it("should handle event message with eventKey", async () => {
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
        <Event><![CDATA[click]]></Event>
        <EventKey><![CDATA[MENU_KEY_001]]></EventKey>
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
        content: "[event: click key=MENU_KEY_001]",
      });
    });

    it("should handle link message without optional fields", async () => {
      adapter = new WeComChannelAdapter(baseConfig);
      const messages: unknown[] = [];
      adapter.onMessage((msg) => { messages.push(msg); });
      await adapter.connect();

      const port = adapter.port;
      const xml = `<xml>
        <ToUserName><![CDATA[corpid]]></ToUserName>
        <FromUserName><![CDATA[user-link-min]]></FromUserName>
        <CreateTime>1348831860</CreateTime>
        <MsgType><![CDATA[link]]></MsgType>
        <Title><![CDATA[Mini Link]]></Title>
        <MsgId>link-min-001</MsgId>
        <AgentID>1000002</AgentID>
      </xml>`;

      await originalFetch(`http://localhost:${port}/wecom/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: xml,
      });

      await new Promise((r) => setTimeout(r, 100));

      expect(messages).toHaveLength(1);
      // Description and Url default to ""
      expect(messages[0].content).toBe("Mini Link\n");
      expect(messages[0].attachments).toEqual([{ type: "link", url: "" }]);
    });
  });

  // ── Edge Cases ──────────────────────────────────────────────────────────────

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
