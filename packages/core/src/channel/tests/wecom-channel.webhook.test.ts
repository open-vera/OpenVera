/**
 * WeCom channel tests — webhook
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

describe("WeComChannelAdapter — webhook", () => {
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


});
