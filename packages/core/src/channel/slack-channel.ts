/**
 * Slack Channel Adapter — Slack Bot API integration.
 *
 * Implements the ChannelAdapter interface for Slack bots using the
 * Slack Events API (HTTP webhook) + Slack Web API.
 *
 * Features:
 *   - Slack Events API for receiving messages (HTTP webhook)
 *   - Slack Web API for sending messages (text, blocks, attachments)
 *   - Signature verification using Slack signing secret
 *   - URL verification challenge handling
 *   - Message types: text, file shares, links
 *   - Channel/workspace awareness
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
import { appendBotMessage, filterChannelHistory, subscribeMessage } from "./channel-helpers.js";
import { ChannelNotConnectedError, ChannelSendError, ChannelConnectionError } from "./types.js";

// ── Configuration ─────────────────────────────────────────────────────────────

export interface SlackChannelConfig {
  /** Slack Bot OAuth token (xoxb-...) */
  botToken: string;
  /** Slack Signing Secret for request verification */
  signingSecret: string;
  /** Slack App-Level Token (xapp-...) for Socket Mode (optional) */
  appLevelToken?: string;
  /** Webhook server host (default: "0.0.0.0") */
  host?: string;
  /** Webhook server port (default: 0 = auto-assign) */
  port?: number;
  /** Webhook path (default: "/slack/events") */
  path?: string;
  /** Slack API base URL (default: "https://slack.com/api") */
  apiBaseUrl?: string;
  /** Custom message ID generator */
  generateId?: () => string;
  /** Maximum request body size in bytes (default: 2MB) */
  maxBodyBytes?: number;
}

interface SlackInternalConfig {
  botToken: string;
  signingSecret: string;
  appLevelToken: string;
  host: string;
  port: number;
  path: string;
  apiBaseUrl: string;
  generateId: () => string;
  maxBodyBytes: number;
}

const DEFAULT_CONFIG = {
  host: "0.0.0.0",
  port: 0,
  path: "/slack/events",
  apiBaseUrl: "https://slack.com/api",
  maxBodyBytes: 2_097_152,
};

// ── Slack API Types ───────────────────────────────────────────────────────────

interface SlackEventBase {
  token: string;
  team_id: string;
  api_app_id: string;
  event: SlackEvent;
  type: "event_callback" | "url_verification";
  event_id: string;
  event_time: number;
}

interface SlackUrlVerification {
  type: "url_verification";
  token: string;
  challenge: string;
}

interface SlackMessageEvent {
  type: "message";
  subtype?: string;
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
  bot_profile?: SlackBotProfile;
  files?: SlackFile[];
  attachments?: SlackAttachment[];
  blocks?: SlackBlock[];
}

interface SlackFileShareEvent {
  type: "message";
  subtype: "file_share";
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
  files: SlackFile[];
}

interface SlackBotProfile {
  id: string;
  name: string;
  app_id: string;
  team_id: string;
}

interface SlackFile {
  id: string;
  name: string;
  title: string;
  mimetype: string;
  filetype: string;
  size: number;
  url_private: string;
  permalink: string;
  permalink_public?: string;
}

interface SlackAttachment {
  id?: number;
  fallback?: string;
  color?: string;
  pretext?: string;
  author_name?: string;
  title?: string;
  title_link?: string;
  text?: string;
  image_url?: string;
  thumb_url?: string;
  footer?: string;
  ts?: number;
}

interface SlackBlock {
  type: string;
  block_id?: string;
  text?: SlackTextObject;
  elements?: SlackBlockElement[];
  accessory?: SlackBlockElement;
}

interface SlackTextObject {
  type: "plain_text" | "mrkdwn";
  text: string;
  emoji?: boolean;
  verbatim?: boolean;
}

interface SlackBlockElement {
  type: string;
  text?: string | SlackTextObject;
  url?: string;
  value?: string;
  style?: string;
}

type SlackEvent = SlackMessageEvent | SlackFileShareEvent | Record<string, unknown>;

interface SlackEventEnvelope {
  token: string;
  team_id: string;
  api_app_id: string;
  event: SlackEvent;
  type: string;
  event_id: string;
  event_time: number;
  authed_users?: string[];
}

interface SlackChatPostMessageResponse {
  ok: boolean;
  channel?: string;
  ts?: string;
  message?: {
    text: string;
    ts: string;
    bot_id?: string;
  };
  error?: string;
}

interface SlackAuthTestResponse {
  ok: boolean;
  url?: string;
  team?: string;
  user?: string;
  team_id?: string;
  user_id?: string;
  bot_id?: string;
  error?: string;
}

// ── Slack Channel Adapter ─────────────────────────────────────────────────────

export class SlackChannelAdapter implements ChannelAdapter {
  readonly name = "slack";
  readonly channelType = "slack" as const;

  private _state: ConnectionState = "disconnected";
  private config: SlackInternalConfig;
  private server: Server | null = null;
  private callbacks: MessageCallback[] = [];
  private history: ChannelMessage[] = [];
  private sentCount = 0;
  private receivedCount = 0;
  private stateChangedAt: string = new Date().toISOString();
  private actualPort = 0;

  constructor(config: SlackChannelConfig) {
    if (!config.botToken) throw new Error("SlackChannelConfig.botToken is required");
    if (!config.signingSecret) throw new Error("SlackChannelConfig.signingSecret is required");

    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      appLevelToken: config.appLevelToken ?? "",
      generateId: config.generateId ?? (() => `slack-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
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

    // Validate token by calling auth.test
    try {
      await this.apiCall<SlackAuthTestResponse>("auth.test");
    } catch (err) {
      this.setState("error");
      throw new ChannelConnectionError(this.name, `Failed to validate bot token: ${err}`);
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
        this.setState("disconnected");
        resolve();
      });
    });
  }

  getStatus(): ChannelStatus {
    return {
      state: this._state,
      message: `Slack bot on port ${this.actualPort}, path ${this.config.path}`,
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
      channelId?: string;
      threadTs?: string;
      blocks?: SlackBlock[];
      attachments?: SlackAttachment[];
      iconEmoji?: string;
      username?: string;
      unfurlLinks?: boolean;
      unfurlMedia?: boolean;
    };

    const channelId = channelOpts.channelId;
    if (!channelId) {
      throw new ChannelSendError(this.name, "channelId is required in channelOptions");
    }

    const body: Record<string, unknown> = {
      channel: channelId,
      text: options.content,
    };

    if (channelOpts.threadTs) {
      body.thread_ts = channelOpts.threadTs;
    }

    if (channelOpts.blocks?.length) {
      body.blocks = channelOpts.blocks;
    }

    if (channelOpts.attachments?.length) {
      body.attachments = channelOpts.attachments;
    }

    if (channelOpts.iconEmoji) {
      body.icon_emoji = channelOpts.iconEmoji;
    }

    if (channelOpts.username) {
      body.username = channelOpts.username;
    }

    if (channelOpts.unfurlLinks !== undefined) {
      body.unfurl_links = channelOpts.unfurlLinks;
    }

    if (channelOpts.unfurlMedia !== undefined) {
      body.unfurl_media = channelOpts.unfurlMedia;
    }

    const result = await this.apiCall<SlackChatPostMessageResponse>("chat.postMessage", body);

    if (!result.ok) {
      throw new ChannelSendError(this.name, `Slack API error: ${result.error ?? "unknown"}`);
    }

    const message = appendBotMessage(
      this.history,
      this.channelType,
      options,
      this.config.generateId,
      {
        timestamp: result.ts
          ? new Date(parseFloat(result.ts) * 1000).toISOString()
          : new Date().toISOString(),
      }
    );
    this.sentCount++;

    return message;
  }

  onMessage(callback: MessageCallback): () => void {
    return subscribeMessage(this.callbacks, callback);
  }

  async getHistory(options?: HistoryOptions): Promise<ChannelMessage[]> {
    return filterChannelHistory(this.history, options);
  }

  // ── HTTP Request Handling ──────────────────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Slack-Request-Timestamp, X-Slack-Signature");

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

    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    try {
      const body = await this.readBody(req);
      if (!body) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Empty body");
        return;
      }

      const rawBody = body.toString("utf-8");

      // Verify signature
      const timestamp = req.headers["x-slack-request-timestamp"] as string | undefined;
      const signature = req.headers["x-slack-signature"] as string | undefined;

      if (!this.verifySignature(rawBody, timestamp, signature)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Invalid signature");
        return;
      }

      const payload = JSON.parse(rawBody) as SlackEventEnvelope | SlackUrlVerification;

      // Handle URL verification challenge
      if (payload.type === "url_verification") {
        const challenge = payload as SlackUrlVerification;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ challenge: challenge.challenge }));
        return;
      }

      // Respond immediately for event callbacks
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));

      // Process event asynchronously
      if (payload.type === "event_callback") {
        await this.handleEvent(payload as SlackEventEnvelope);
      }
    } catch {
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

  // ── Signature Verification ─────────────────────────────────────────────────

  private verifySignature(body: string, timestamp: string | undefined, signature: string | undefined): boolean {
    if (!timestamp || !signature) return false;

    // Reject requests older than 5 minutes to prevent replay attacks
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(timestamp, 10)) > 300) return false;

    const baseString = `v0:${timestamp}:${body}`;
    const hmac = createHmac("sha256", this.config.signingSecret).update(baseString).digest("hex");
    const expected = `v0=${hmac}`;

    if (signature.length !== expected.length) return false;

    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }

  // ── Event Handling ─────────────────────────────────────────────────────────

  private async handleEvent(envelope: SlackEventEnvelope): Promise<void> {
    const event = envelope.event;
    if (!event) return;

    const eventType = event.type;

    if (eventType === "message") {
      await this.handleMessageEvent(event as SlackMessageEvent | SlackFileShareEvent, envelope);
    }
  }

  private async handleMessageEvent(
    event: SlackMessageEvent | SlackFileShareEvent,
    envelope: SlackEventEnvelope,
  ): Promise<void> {
    // Ignore bot messages to avoid loops
    if ("bot_id" in event && event.bot_id) return;
    if ("bot_profile" in event && event.bot_profile) return;

    const senderId = event.user ?? "unknown";
    let content = event.text ?? "";
    const attachments: ChannelAttachment[] = [];

    // Handle file_share subtype
    if (event.subtype === "file_share" && "files" in event && event.files) {
      for (const file of event.files) {
        const attType = file.mimetype?.startsWith("image/") ? "image" : "file";
        attachments.push({
          type: attType as ChannelAttachment["type"],
          url: file.url_private ?? file.permalink ?? "",
          name: file.name ?? file.title,
          mimeType: file.mimetype,
          sizeBytes: file.size,
        });
      }
      if (!content) content = "[file share]";
    }

    // Handle link attachments
    if ("attachments" in event && event.attachments) {
      for (const att of event.attachments) {
        if (att.title_link || att.image_url || att.thumb_url) {
          attachments.push({
            type: att.image_url ? "image" : "link",
            url: att.title_link ?? att.image_url ?? att.thumb_url ?? "",
            name: att.title,
          });
        }
      }
    }

    if (!content && attachments.length === 0) return;

    const ts = "ts" in event ? event.ts : String(envelope.event_time);
    const threadTs = "thread_ts" in event ? event.thread_ts : undefined;

    const message: ChannelMessage = {
      id: this.config.generateId(),
      channelType: this.channelType,
      senderId,
      content,
      attachments,
      replyTo: threadTs,
      timestamp: new Date(parseFloat(ts) * 1000).toISOString(),
      raw: {
        teamId: envelope.team_id,
        channelId: event.channel,
        threadTs,
        subtype: event.subtype,
      },
    };

    this.history.push(message);
    this.receivedCount++;

    for (const cb of this.callbacks) {
      await cb(message);
    }
  }

  // ── API Helpers ────────────────────────────────────────────────────────────

  private async apiCall<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    const url = `${this.config.apiBaseUrl}/${method}`;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${this.config.botToken}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!resp.ok) {
      const errorBody = await resp.text().catch(() => "unknown");
      throw new Error(`Slack API ${method} failed (${resp.status}): ${errorBody}`);
    }

    return resp.json() as Promise<T>;
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private setState(state: ConnectionState): void {
    this._state = state;
    this.stateChangedAt = new Date().toISOString();
  }
}
