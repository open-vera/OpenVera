/**
 * Feishu (Lark) Channel Adapter — Feishu Bot message receiving/sending.
 *
 * Implements the ChannelAdapter interface for Feishu Open Platform bots.
 *
 * Features:
 *   - Webhook event subscription (challenge-response verification)
 *   - Message sending via Feishu Open API (text, post, image, file)
 *   - Tenant access token management (auto-refresh)
 *   - Event types: im.message.receive_v1, url_verification
 */

import { createHmac, timingSafeEqual } from "node:crypto";
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

export interface FeishuChannelConfig {
  /** Feishu app ID */
  appId: string;
  /** Feishu app secret */
  appSecret: string;
  /** Verification token for event subscription */
  verificationToken: string;
  /** Encrypt key for event body decryption (optional) */
  encryptKey?: string;
  /** Webhook server host (default: "0.0.0.0") */
  host?: string;
  /** Webhook server port (default: 0 = auto-assign) */
  port?: number;
  /** Webhook path (default: "/feishu/webhook") */
  path?: string;
  /** Feishu API base URL (default: "https://open.feishu.cn") */
  apiBaseUrl?: string;
  /** Custom message ID generator */
  generateId?: () => string;
  /** Maximum request body size in bytes (default: 2MB) */
  maxBodyBytes?: number;
}

interface FeishuInternalConfig {
  host: string;
  port: number;
  path: string;
  apiBaseUrl: string;
  maxBodyBytes: number;
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey?: string;
  generateId: () => string;
}

const DEFAULT_CONFIG = {
  host: "0.0.0.0",
  port: 0,
  path: "/feishu/webhook",
  apiBaseUrl: "https://open.feishu.cn",
  maxBodyBytes: 2_097_152,
};

// ── Feishu API Types ──────────────────────────────────────────────────────────

interface FeishuTokenResponse {
  code: number;
  msg: string;
  tenant_access_token: string;
  expire: number;
}

interface FeishuSendMessageResponse {
  code: number;
  msg: string;
  data?: {
    message_id: string;
  };
}

interface FeishuEventBody {
  /** Challenge for url_verification */
  challenge?: string;
  /** Event type */
  type?: string;
  /** Token for verification */
  token?: string;
  /** Schema version */
  schema?: string;
  /** Event header (v2 schema) */
  header?: {
    event_id?: string;
    event_type?: string;
    token?: string;
    create_time?: string;
  };
  /** Event data (v2 schema) */
  event?: Record<string, unknown>;
  /** v1 schema fields */
  uuid?: string;
  event_type?: string;
  ts?: string;
}

// ── Feishu Channel Adapter ────────────────────────────────────────────────────

export class FeishuChannelAdapter implements ChannelAdapter {
  readonly name = "feishu";
  readonly channelType = "feishu" as const;

  private _state: ConnectionState = "disconnected";
  private config: FeishuInternalConfig;
  private server: Server | null = null;
  private callbacks: MessageCallback[] = [];
  private history: ChannelMessage[] = [];
  private sentCount = 0;
  private receivedCount = 0;
  private stateChangedAt: string = new Date().toISOString();
  private actualPort = 0;

  // Token management
  private tenantAccessToken: string | null = null;
  private tokenExpiresAt = 0;
  private tokenRefreshPromise: Promise<string> | null = null;

  constructor(config: FeishuChannelConfig) {
    if (!config.appId) throw new Error("FeishuChannelConfig.appId is required");
    if (!config.appSecret) throw new Error("FeishuChannelConfig.appSecret is required");
    if (!config.verificationToken) throw new Error("FeishuChannelConfig.verificationToken is required");

    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      generateId: config.generateId ?? (() => `feishu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    };
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
      throw new ChannelConnectionError(this.name, `Failed to obtain tenant_access_token: ${err}`);
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
        this.tenantAccessToken = null;
        this.tokenExpiresAt = 0;
        this.setState("disconnected");
        resolve();
      });
    });
  }

  getStatus(): ChannelStatus {
    return {
      state: this._state,
      message: `Feishu bot on port ${this.actualPort}, path ${this.config.path}`,
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
      receiveId?: string;
      receiveIdType?: "open_id" | "user_id" | "union_id" | "email" | "chat_id";
      msgType?: "text" | "post" | "image" | "file";
    };

    const receiveId = channelOpts.receiveId;
    const receiveIdType = channelOpts.receiveIdType ?? "open_id";

    if (!receiveId) {
      throw new ChannelSendError(this.name, "channelOptions.receiveId is required (target user/chat ID)");
    }

    const msgType = channelOpts.msgType ?? "text";
    const token = await this.getAccessToken();

    // Build message content based on type
    let content: string;
    if (msgType === "text") {
      content = JSON.stringify({ text: options.content });
    } else if (msgType === "post") {
      // Rich text format
      content = JSON.stringify({
        zh_cn: {
          title: "",
          content: [[{ tag: "text", text: options.content }]],
        },
      });
    } else {
      content = options.content;
    }

    // Send via Feishu Open API
    const url = `${this.config.apiBaseUrl}/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`;
    const body = JSON.stringify({
      receive_id: receiveId,
      msg_type: msgType,
      content,
    });

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body,
    });

    const data = await resp.json() as FeishuSendMessageResponse;
    if (data.code !== 0) {
      throw new ChannelSendError(this.name, `Feishu API error: ${data.msg} (code: ${data.code})`);
    }

    const message: ChannelMessage = {
      id: data.data?.message_id ?? this.config.generateId(),
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
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${this.actualPort}`);

    if (req.method !== "POST" || url.pathname !== this.config.path) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    try {
      const body = await this.readBody(req);
      if (!body) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Empty request body" }));
        return;
      }

      // Handle url_verification challenge
      if (body.type === "url_verification") {
        const challenge = body.challenge as string;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ challenge }));
        return;
      }

      // Verify event token
      const eventToken = body.token ?? body.header?.token;
      if (eventToken && eventToken !== this.config.verificationToken) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid verification token" }));
        return;
      }

      // Dispatch to event handler (non-blocking)
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));

      await this.handleEvent(body);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    }
  }

  private readBody(req: IncomingMessage): Promise<FeishuEventBody | null> {
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
        if (raw.length === 0) {
          resolve(null);
          return;
        }
        try {
          const body = JSON.parse(raw.toString("utf-8")) as FeishuEventBody;
          resolve(body);
        } catch {
          reject(new Error("Invalid JSON"));
        }
      });

      req.on("error", reject);
    });
  }

  // ── Event Handling ─────────────────────────────────────────────────────────

  private async handleEvent(body: FeishuEventBody): Promise<void> {
    // v2 schema
    if (body.schema === "2.0" && body.header?.event_type === "im.message.receive_v1") {
      await this.handleMessageEvent(body.event as Record<string, unknown> | undefined);
      return;
    }

    // v1 schema
    if (body.event_type === "message" && body.event) {
      await this.handleMessageEventV1(body.event as Record<string, unknown>);
      return;
    }
  }

  /** Handle v2 im.message.receive_v1 event */
  private async handleMessageEvent(event: Record<string, unknown> | undefined): Promise<void> {
    if (!event) return;

    const message = event.message as Record<string, unknown> | undefined;
    const sender = event.sender as Record<string, unknown> | undefined;

    if (!message) return;

    const messageId = message.message_id as string | undefined;
    const msgType = message.message_type as string | undefined;
    const contentStr = message.content as string | undefined;
    const chatId = message.chat_id as string | undefined;
    const senderId = (sender?.sender_id as Record<string, unknown>)?.open_id as string | undefined;

    let content = "";
    const attachments: ChannelAttachment[] = [];

    if (msgType === "text" && contentStr) {
      try {
        const parsed = JSON.parse(contentStr) as { text?: string };
        content = parsed.text ?? contentStr;
      } catch {
        content = contentStr;
      }
    } else if (msgType === "image" && contentStr) {
      try {
        const parsed = JSON.parse(contentStr) as { image_key?: string };
        attachments.push({
          type: "image",
          url: parsed.image_key ?? "",
        });
        content = "[image]";
      } catch {
        content = "[image]";
      }
    } else if (msgType === "file" && contentStr) {
      try {
        const parsed = JSON.parse(contentStr) as { file_key?: string; file_name?: string };
        attachments.push({
          type: "file",
          url: parsed.file_key ?? "",
          name: parsed.file_name,
        });
        content = `[file: ${parsed.file_name ?? "unknown"}]`;
      } catch {
        content = "[file]";
      }
    } else if (contentStr) {
      content = contentStr;
    }

    if (!content) return;

    const channelMessage: ChannelMessage = {
      id: messageId ?? this.config.generateId(),
      channelType: this.channelType,
      senderId: senderId ?? "unknown",
      content,
      attachments,
      timestamp: new Date().toISOString(),
      raw: { chatId, msgType, schema: "2.0" },
    };

    this.history.push(channelMessage);
    this.receivedCount++;

    for (const cb of this.callbacks) {
      await cb(channelMessage);
    }
  }

  /** Handle v1 message event (legacy) */
  private async handleMessageEventV1(event: Record<string, unknown>): Promise<void> {
    const msgType = event.msg_type as string | undefined;
    const text = event.text as string | undefined;
    const messageId = event.msg_id as string | undefined;
    const openId = event.open_id as string | undefined;

    let content = text ?? "";
    if (msgType === "text") {
      // Strip @mention prefix if present
      content = content.replace(/^@_user_\d+\s*/, "").trim();
    }

    if (!content) return;

    const channelMessage: ChannelMessage = {
      id: messageId ?? this.config.generateId(),
      channelType: this.channelType,
      senderId: openId ?? "unknown",
      content,
      attachments: [],
      timestamp: new Date().toISOString(),
      raw: { msgType, schema: "1.0" },
    };

    this.history.push(channelMessage);
    this.receivedCount++;

    for (const cb of this.callbacks) {
      await cb(channelMessage);
    }
  }

  // ── Token Management ───────────────────────────────────────────────────────

  /**
   * Get tenant_access_token with auto-refresh.
   * Concurrent calls share a single refresh promise.
   */
  private async getAccessToken(): Promise<string> {
    // Return cached token if still valid (with 60s buffer)
    if (this.tenantAccessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.tenantAccessToken;
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
    const url = `${this.config.apiBaseUrl}/open-apis/auth/v3/tenant_access_token/internal`;
    const body = JSON.stringify({
      app_id: this.config.appId,
      app_secret: this.config.appSecret,
    });

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body,
    });

    const data = await resp.json() as FeishuTokenResponse;
    if (data.code !== 0) {
      throw new Error(`Failed to get tenant_access_token: ${data.msg} (code: ${data.code})`);
    }

    this.tenantAccessToken = data.tenant_access_token;
    this.tokenExpiresAt = Date.now() + data.expire * 1000;
    return this.tenantAccessToken;
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private setState(state: ConnectionState): void {
    this._state = state;
    this.stateChangedAt = new Date().toISOString();
  }
}
