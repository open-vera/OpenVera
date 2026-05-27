/**
 * WeCom (企业微信) Channel Adapter — WeCom Bot message receiving/sending.
 *
 * Implements the ChannelAdapter interface for WeCom (WeChat Work) bots.
 *
 * Features:
 *   - Webhook event subscription (verification + AES decryption)
 *   - Message sending via WeCom API (text, markdown, image, news)
 *   - Access token management (auto-refresh)
 *   - Event types: text, image, voice, video, location, link
 */

import { createHash } from "node:crypto";
import { createDecipheriv, createCipheriv, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type {
  ChannelAdapter,
  ChannelAttachment,
  ChannelMessage,
  ChannelStatus,
  ConnectionState,
  HistoryOptions,
  MessageCallback,
  SendMessageOptions,
} from "./types.js";
import { ChannelNotConnectedError, ChannelSendError, ChannelConnectionError } from "./types.js";

// ── Configuration ─────────────────────────────────────────────────────────────

export interface WeComChannelConfig {
  /** WeCom corp ID (企业 ID) */
  corpId: string;
  /** WeCom application secret */
  corpSecret: string;
  /** WeCom agent ID (应用 ID) */
  agentId: number;
  /** Token for message verification (from WeCom admin) */
  token: string;
  /** EncodingAESKey for message encryption (from WeCom admin) */
  encodingAesKey: string;
  /** Webhook server host (default: "0.0.0.0") */
  host?: string;
  /** Webhook server port (default: 0 = auto-assign) */
  port?: number;
  /** Webhook path (default: "/wecom/webhook") */
  path?: string;
  /** WeCom API base URL (default: "https://qyapi.weixin.qq.com") */
  apiBaseUrl?: string;
  /** Custom message ID generator */
  generateId?: () => string;
  /** Maximum request body size in bytes (default: 2MB) */
  maxBodyBytes?: number;
}

interface WeComInternalConfig {
  host: string;
  port: number;
  path: string;
  apiBaseUrl: string;
  maxBodyBytes: number;
  corpId: string;
  corpSecret: string;
  agentId: number;
  token: string;
  encodingAesKey: string;
  generateId: () => string;
}

const DEFAULT_CONFIG = {
  host: "0.0.0.0",
  port: 0,
  path: "/wecom/webhook",
  apiBaseUrl: "https://qyapi.weixin.qq.com",
  maxBodyBytes: 2_097_152,
};

// ── WeCom API Types ───────────────────────────────────────────────────────────

interface WeComTokenResponse {
  errcode: number;
  errmsg: string;
  access_token: string;
  expires_in: number;
}

interface WeComSendMessageResponse {
  errcode: number;
  errmsg: string;
  invaliduser?: string;
  invalidparty?: string;
  invalidtag?: string;
}

interface WeComEventBody {
  /** XML string from WeCom callback */
  xml?: {
    ToUserName?: string[];
    FromUserName?: string[];
    CreateTime?: string[];
    MsgType?: string[];
    Content?: string[];
    MsgId?: string[];
    AgentID?: string[];
    PicUrl?: string[];
    MediaId?: string[];
    Event?: string[];
    EventKey?: string[];
  };
  /** Encrypted message */
  encrypt?: string;
}

// ── XML Parsing Helpers ───────────────────────────────────────────────────────

function extractXmlValue(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[(.*?)\\]\\]></${tag}>`))
    ?? xml.match(new RegExp(`<${tag}>(.+?)</${tag}>`));
  return match?.[1];
}

function parseWeComXml(xml: string): Record<string, string> {
  const result: Record<string, string> = {};
  const tags = ["ToUserName", "FromUserName", "CreateTime", "MsgType", "Content",
    "MsgId", "AgentID", "PicUrl", "MediaId", "Event", "EventKey",
    "Title", "Description", "Url", "Format", "Recognition"];
  for (const tag of tags) {
    const val = extractXmlValue(xml, tag);
    if (val !== undefined) result[tag] = val;
  }
  return result;
}

// ── Crypto Helpers (WXBizMsgCrypt) ────────────────────────────────────────────

function deriveAesKey(encodingAesKey: string): Buffer {
  return Buffer.from(encodingAesKey + "=", "base64");
}

function pkcs7Pad(data: Buffer, blockSize: number): Buffer {
  const padLen = blockSize - (data.length % blockSize);
  const padded = Buffer.alloc(data.length + padLen, padLen);
  data.copy(padded);
  return padded;
}

function pkcs7Unpad(data: Buffer): Buffer {
  const padLen = data[data.length - 1];
  if (padLen < 1 || padLen > 32) return data;
  return data.subarray(0, data.length - padLen);
}

function decryptMessage(encrypted: string, aesKey: Buffer, corpId: string): string {
  const encryptedBuf = Buffer.from(encrypted, "base64");
  const iv = aesKey.subarray(0, 16);
  const decipher = createDecipheriv("aes-256-cbc", aesKey, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(encryptedBuf), decipher.final()]);
  const unpadded = pkcs7Unpad(decrypted);
  // First 16 bytes are random, next 4 bytes are msg length (network byte order), then msg, then corpId
  const msgLen = unpadded.readUInt32BE(16);
  const msg = unpadded.subarray(20, 20 + msgLen).toString("utf-8");
  const id = unpadded.subarray(20 + msgLen).toString("utf-8");
  if (id !== corpId) {
    throw new Error("CorpId mismatch in decrypted message");
  }
  return msg;
}

function encryptMessage(msg: string, aesKey: Buffer, corpId: string): string {
  const msgBuf = Buffer.from(msg, "utf-8");
  const randomBuf = randomBytes(16);
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

function computeSignature(token: string, timestamp: string, nonce: string, encrypted: string): string {
  const arr = [token, timestamp, nonce, encrypted].sort();
  return createHash("sha1").update(arr.join("")).digest("hex");
}

// ── WeCom Channel Adapter ─────────────────────────────────────────────────────

export class WeComChannelAdapter implements ChannelAdapter {
  readonly name = "wecom";
  readonly channelType = "wecom" as const;

  private _state: ConnectionState = "disconnected";
  private config: WeComInternalConfig;
  private server: Server | null = null;
  private callbacks: MessageCallback[] = [];
  private history: ChannelMessage[] = [];
  private sentCount = 0;
  private receivedCount = 0;
  private stateChangedAt: string = new Date().toISOString();
  private actualPort = 0;

  // Token management
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private tokenRefreshPromise: Promise<string> | null = null;

  // Crypto
  private aesKey: Buffer;

  constructor(config: WeComChannelConfig) {
    if (!config.corpId) throw new Error("WeComChannelConfig.corpId is required");
    if (!config.corpSecret) throw new Error("WeComChannelConfig.corpSecret is required");
    if (!config.agentId) throw new Error("WeComChannelConfig.agentId is required");
    if (!config.token) throw new Error("WeComChannelConfig.token is required");
    if (!config.encodingAesKey) throw new Error("WeComChannelConfig.encodingAesKey is required");
    if (config.encodingAesKey.length !== 43) {
      throw new Error("WeComChannelConfig.encodingAesKey must be 43 characters");
    }

    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      generateId: config.generateId ?? (() => `wecom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    };

    this.aesKey = deriveAesKey(config.encodingAesKey);
  }

  get state(): ConnectionState {
    return this._state;
  }

  get port(): number {
    return this.actualPort;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this._state === "connected" || this._state === "connecting") return;

    this.setState("connecting");

    // Validate credentials by fetching a token
    try {
      await this.getAccessToken();
    } catch (err) {
      this.setState("error");
      throw new ChannelConnectionError(this.name, `Failed to obtain access_token: ${err}`);
    }

    return new Promise<void>((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));

      this.server.on("error", (err) => {
        if (this._state === "connecting") {
          this.setState("error");
          reject(err);
        }
      });

      this.server.listen(this.config.port, this.config.host, () => {
        const addr = this.server!.address();
        this.actualPort = typeof addr === "object" && addr ? addr.port : this.config.port;
        this.setState("connected");
        resolve();
      });
    });
  }

  async disconnect(): Promise<void> {
    if (!this.server) {
      this.setState("disconnected");
      return;
    }

    return new Promise<void>((resolve) => {
      this.server!.close(() => {
        this.server = null;
        this.accessToken = null;
        this.tokenExpiresAt = 0;
        this.setState("disconnected");
        resolve();
      });
    });
  }

  getStatus(): ChannelStatus {
    return {
      state: this._state,
      message: `WeCom bot on port ${this.actualPort}, path ${this.config.path}`,
      changedAt: this.stateChangedAt,
      sentCount: this.sentCount,
      receivedCount: this.receivedCount,
    };
  }

  // ── Messaging ──────────────────────────────────────────────────────────────

  async sendMessage(options: SendMessageOptions): Promise<ChannelMessage> {
    if (this._state !== "connected") {
      throw new ChannelNotConnectedError(this.name);
    }

    const channelOpts = (options.channelOptions ?? {}) as {
      toUser?: string;
      toParty?: string;
      toTag?: string;
      msgType?: "text" | "markdown" | "image" | "news";
      mediaId?: string;
      articles?: Array<{ title: string; description?: string; url: string; picUrl?: string }>;
    };

    const toUser = channelOpts.toUser ?? "@all";
    const msgType = channelOpts.msgType ?? "text";
    const token = await this.getAccessToken();

    // Build message body based on type
    let body: Record<string, unknown>;

    if (msgType === "text") {
      body = {
        touser: toUser,
        msgtype: "text",
        agentid: this.config.agentId,
        text: { content: options.content },
      };
      if (channelOpts.toParty) (body as Record<string, unknown>).toparty = channelOpts.toParty;
      if (channelOpts.toTag) (body as Record<string, unknown>).totag = channelOpts.toTag;
    } else if (msgType === "markdown") {
      body = {
        touser: toUser,
        msgtype: "markdown",
        agentid: this.config.agentId,
        markdown: { content: options.content },
      };
    } else if (msgType === "image" && channelOpts.mediaId) {
      body = {
        touser: toUser,
        msgtype: "image",
        agentid: this.config.agentId,
        image: { media_id: channelOpts.mediaId },
      };
    } else if (msgType === "news" && channelOpts.articles) {
      body = {
        touser: toUser,
        msgtype: "news",
        agentid: this.config.agentId,
        news: { articles: channelOpts.articles },
      };
    } else {
      body = {
        touser: toUser,
        msgtype: "text",
        agentid: this.config.agentId,
        text: { content: options.content },
      };
    }

    // Send via WeCom API
    const url = `${this.config.apiBaseUrl}/cgi-bin/message/send?access_token=${token}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });

    const data = await resp.json() as WeComSendMessageResponse;
    if (data.errcode !== 0) {
      throw new ChannelSendError(this.name, `WeCom API error: ${data.errmsg} (code: ${data.errcode})`);
    }

    const message: ChannelMessage = {
      id: this.config.generateId(),
      channelType: this.channelType,
      senderId: "bot",
      content: options.content,
      attachments: options.attachments ?? [],
      timestamp: new Date().toISOString(),
    };
    this.history.push(message);
    this.sentCount++;

    return message;
  }

  onMessage(callback: MessageCallback): () => void {
    this.callbacks.push(callback);
    return () => {
      const idx = this.callbacks.indexOf(callback);
      if (idx >= 0) this.callbacks.splice(idx, 1);
    };
  }

  async getHistory(options?: HistoryOptions): Promise<ChannelMessage[]> {
    let result = [...this.history];

    if (options?.after) {
      result = result.filter((m) => m.timestamp > options.after!);
    }
    if (options?.before) {
      result = result.filter((m) => m.timestamp < options.before!);
    }
    if (options?.senderId) {
      result = result.filter((m) => m.senderId === options.senderId);
    }
    if (options?.limit) {
      result = result.slice(0, options.limit);
    }
    return result;
  }

  // ── HTTP Request Handling ──────────────────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${this.actualPort}`);

    if (url.pathname !== this.config.path) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    // GET = verification request from WeCom
    if (req.method === "GET") {
      this.handleVerification(url, res);
      return;
    }

    // POST = message callback
    if (req.method === "POST") {
      await this.handleCallback(req, res);
      return;
    }

    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  /** Handle WeCom verification challenge (GET request) */
  private handleVerification(url: URL, res: ServerResponse): void {
    const msgSignature = url.searchParams.get("msg_signature") ?? "";
    const timestamp = url.searchParams.get("timestamp") ?? "";
    const nonce = url.searchParams.get("nonce") ?? "";
    const echoStr = url.searchParams.get("echostr") ?? "";

    // Verify signature
    const expectedSignature = computeSignature(this.config.token, timestamp, nonce, echoStr);
    if (msgSignature !== expectedSignature) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Invalid signature");
      return;
    }

    // Decrypt echostr and return plain text
    try {
      const decrypted = decryptMessage(echoStr, this.aesKey, this.config.corpId);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(decrypted);
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Decryption failed");
    }
  }

  /** Handle WeCom message callback (POST request) */
  private async handleCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.readBody(req);
      if (!body) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Empty body");
        return;
      }

      const url = new URL(req.url ?? "/", `http://localhost:${this.actualPort}`);
      const msgSignature = url.searchParams.get("msg_signature") ?? "";
      const timestamp = url.searchParams.get("timestamp") ?? "";
      const nonce = url.searchParams.get("nonce") ?? "";

      // Parse XML body
      const xml = body.toString("utf-8");
      const encrypt = extractXmlValue(xml, "Encrypt");

      if (encrypt) {
        // Verify signature
        const expectedSignature = computeSignature(this.config.token, timestamp, nonce, encrypt);
        if (msgSignature !== expectedSignature) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Invalid signature");
          return;
        }

        // Decrypt message
        const decrypted = decryptMessage(encrypt, this.aesKey, this.config.corpId);
        const parsed = parseWeComXml(decrypted);

        // Respond immediately
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("success");

        await this.handleEvent(parsed);
      } else {
        // Unencrypted mode (for testing)
        const parsed = parseWeComXml(xml);

        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("success");

        await this.handleEvent(parsed);
      }
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal error");
      }
    }
  }

  private readBody(req: IncomingMessage): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;

      req.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > this.config.maxBodyBytes) {
          reject(new Error("Request body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on("end", () => {
        const raw = Buffer.concat(chunks);
        resolve(raw.length > 0 ? raw : null);
      });

      req.on("error", reject);
    });
  }

  // ── Event Handling ─────────────────────────────────────────────────────────

  private async handleEvent(parsed: Record<string, string>): Promise<void> {
    const msgType = parsed.MsgType;
    const fromUser = parsed.FromUserName;
    const msgId = parsed.MsgId;

    if (msgType === "text") {
      const content = parsed.Content ?? "";
      if (!content) return;

      const message: ChannelMessage = {
        id: msgId ?? this.config.generateId(),
        channelType: this.channelType,
        senderId: fromUser ?? "unknown",
        content,
        attachments: [],
        timestamp: new Date().toISOString(),
        raw: { msgType, agentId: parsed.AgentID },
      };

      this.history.push(message);
      this.receivedCount++;

      for (const cb of this.callbacks) {
        await cb(message);
      }
    } else if (msgType === "image") {
      const picUrl = parsed.PicUrl ?? "";
      const mediaId = parsed.MediaId ?? "";

      const message: ChannelMessage = {
        id: msgId ?? this.config.generateId(),
        channelType: this.channelType,
        senderId: fromUser ?? "unknown",
        content: "[image]",
        attachments: [{ type: "image", url: picUrl || mediaId }],
        timestamp: new Date().toISOString(),
        raw: { msgType, mediaId, agentId: parsed.AgentID },
      };

      this.history.push(message);
      this.receivedCount++;

      for (const cb of this.callbacks) {
        await cb(message);
      }
    } else if (msgType === "voice") {
      const recognition = parsed.Recognition;
      const content = recognition ?? "[voice]";

      const message: ChannelMessage = {
        id: msgId ?? this.config.generateId(),
        channelType: this.channelType,
        senderId: fromUser ?? "unknown",
        content,
        attachments: [],
        timestamp: new Date().toISOString(),
        raw: { msgType, mediaId: parsed.MediaId, agentId: parsed.AgentID },
      };

      this.history.push(message);
      this.receivedCount++;

      for (const cb of this.callbacks) {
        await cb(message);
      }
    } else if (msgType === "video" || msgType === "shortvideo") {
      const message: ChannelMessage = {
        id: msgId ?? this.config.generateId(),
        channelType: this.channelType,
        senderId: fromUser ?? "unknown",
        content: `[${msgType}]`,
        attachments: [{ type: "video", url: parsed.MediaId ?? "" }],
        timestamp: new Date().toISOString(),
        raw: { msgType, mediaId: parsed.MediaId, agentId: parsed.AgentID },
      };

      this.history.push(message);
      this.receivedCount++;

      for (const cb of this.callbacks) {
        await cb(message);
      }
    } else if (msgType === "location") {
      const content = `[location: ${parsed.Location_X ?? ""},${parsed.Location_Y ?? ""} ${parsed.Label ?? ""}]`;

      const message: ChannelMessage = {
        id: msgId ?? this.config.generateId(),
        channelType: this.channelType,
        senderId: fromUser ?? "unknown",
        content,
        attachments: [],
        timestamp: new Date().toISOString(),
        raw: { msgType, scale: parsed.Scale, label: parsed.Label, agentId: parsed.AgentID },
      };

      this.history.push(message);
      this.receivedCount++;

      for (const cb of this.callbacks) {
        await cb(message);
      }
    } else if (msgType === "link") {
      const title = parsed.Title ?? "";
      const description = parsed.Description ?? "";
      const url = parsed.Url ?? "";

      const message: ChannelMessage = {
        id: msgId ?? this.config.generateId(),
        channelType: this.channelType,
        senderId: fromUser ?? "unknown",
        content: `${title}\n${description}`,
        attachments: [{ type: "link", url }],
        timestamp: new Date().toISOString(),
        raw: { msgType, title, url, agentId: parsed.AgentID },
      };

      this.history.push(message);
      this.receivedCount++;

      for (const cb of this.callbacks) {
        await cb(message);
      }
    } else if (msgType === "event") {
      // Handle events like enter_agent, subscribe, etc.
      const event = parsed.Event ?? "";
      const eventKey = parsed.EventKey ?? "";

      const message: ChannelMessage = {
        id: this.config.generateId(),
        channelType: this.channelType,
        senderId: fromUser ?? "unknown",
        content: `[event: ${event}${eventKey ? ` key=${eventKey}` : ""}]`,
        attachments: [],
        timestamp: new Date().toISOString(),
        raw: { msgType: "event", event, eventKey, agentId: parsed.AgentID },
      };

      this.history.push(message);
      this.receivedCount++;

      for (const cb of this.callbacks) {
        await cb(message);
      }
    }
  }

  // ── Token Management ───────────────────────────────────────────────────────

  /**
   * Get access_token with auto-refresh.
   * Concurrent calls share a single refresh promise.
   */
  private async getAccessToken(): Promise<string> {
    // Return cached token if still valid (with 60s buffer)
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }

    // Deduplicate concurrent refresh requests
    if (this.tokenRefreshPromise) {
      return this.tokenRefreshPromise;
    }

    this.tokenRefreshPromise = this.refreshToken();

    try {
      const token = await this.tokenRefreshPromise;
      return token;
    } finally {
      this.tokenRefreshPromise = null;
    }
  }

  private async refreshToken(): Promise<string> {
    const url = `${this.config.apiBaseUrl}/cgi-bin/gettoken?corpid=${this.config.corpId}&corpsecret=${this.config.corpSecret}`;

    const resp = await fetch(url, { method: "GET" });
    const data = await resp.json() as WeComTokenResponse;

    if (data.errcode !== 0) {
      throw new Error(`Failed to get access_token: ${data.errmsg} (code: ${data.errcode})`);
    }

    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000;
    return this.accessToken;
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private setState(state: ConnectionState): void {
    this._state = state;
    this.stateChangedAt = new Date().toISOString();
  }
}
