/**
 * Telegram Bot Channel Adapter — Telegram Bot API integration.
 *
 * Implements the ChannelAdapter interface for Telegram bots using the
 * Telegram Bot API (https://core.telegram.org/bots/api).
 *
 * Features:
 *   - Long polling for receiving updates (default)
 *   - Webhook mode for production deployments
 *   - Message types: text, photo, document, sticker, voice, video, location
 *   - Markdown/HTML formatting support
 *   - Reply-to-message support
 *   - Chat type awareness (private, group, supergroup, channel)
 */

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

export interface TelegramChannelConfig {
  /** Telegram Bot API token (from @BotFather) */
  botToken: string;
  /** Polling mode: "long-polling" (default) or "webhook" */
  mode?: "long-polling" | "webhook";
  /** Webhook server host (webhook mode only, default: "0.0.0.0") */
  webhookHost?: string;
  /** Webhook server port (webhook mode only, default: 0 = auto-assign) */
  webhookPort?: number;
  /** Webhook path (webhook mode only, default: "/telegram/webhook") */
  webhookPath?: string;
  /** Public URL for webhook (webhook mode only, required for Telegram) */
  webhookUrl?: string;
  /** Long polling timeout in seconds (default: 30) */
  pollingTimeout?: number;
  /** Allowed updates to subscribe to (default: all message types) */
  allowedUpdates?: string[];
  /** Telegram API base URL (default: "https://api.telegram.org") */
  apiBaseUrl?: string;
  /** Custom message ID generator */
  generateId?: () => string;
  /** Maximum request body size in bytes (webhook mode, default: 2MB) */
  maxBodyBytes?: number;
  /** Offset for long polling (internal state) */
  initialOffset?: number;
}

interface TelegramInternalConfig {
  botToken: string;
  mode: "long-polling" | "webhook";
  webhookHost: string;
  webhookPort: number;
  webhookPath: string;
  webhookUrl: string;
  pollingTimeout: number;
  allowedUpdates: string[];
  apiBaseUrl: string;
  generateId: () => string;
  maxBodyBytes: number;
}

const DEFAULT_CONFIG = {
  mode: "long-polling" as const,
  webhookHost: "0.0.0.0",
  webhookPort: 0,
  webhookPath: "/telegram/webhook",
  webhookUrl: "",
  pollingTimeout: 30,
  allowedUpdates: ["message", "edited_message", "channel_post"],
  apiBaseUrl: "https://api.telegram.org",
  maxBodyBytes: 2_097_152,
};

// ── Telegram API Types ────────────────────────────────────────────────────────

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number }>;
  document?: { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string };
  sticker?: { file_id: string; file_unique_id: string; emoji?: string };
  voice?: { file_id: string; file_unique_id: string; duration: number; mime_type?: string };
  video?: { file_id: string; file_unique_id: string; duration: number; mime_type?: string };
  location?: { latitude: number; longitude: number };
  caption?: string;
  reply_to_message?: TelegramMessage;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

interface TelegramGetMeResult {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

interface TelegramSendMessageResult {
  message_id: number;
  chat: TelegramChat;
  date: number;
  text?: string;
}

// ── Telegram Channel Adapter ──────────────────────────────────────────────────

export class TelegramChannelAdapter implements ChannelAdapter {
  readonly name = "telegram";
  readonly channelType = "telegram" as const;

  private _state: ConnectionState = "disconnected";
  private config: TelegramInternalConfig;
  private server: Server | null = null;
  private callbacks: MessageCallback[] = [];
  private history: ChannelMessage[] = [];
  private sentCount = 0;
  private receivedCount = 0;
  private stateChangedAt: string = new Date().toISOString();

  // Long polling state
  private pollingOffset = 0;
  private pollingAbortController: AbortController | null = null;
  private pollingPromise: Promise<void> | null = null;

  constructor(config: TelegramChannelConfig) {
    if (!config.botToken) throw new Error("TelegramChannelConfig.botToken is required");

    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      generateId: config.generateId ?? (() => `tg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    };

    this.pollingOffset = config.initialOffset ?? 0;
  }

  get state(): ConnectionState {
    return this._state;
  }

  get port(): number {
    if (this.server) {
      const addr = this.server.address();
      return typeof addr === "object" && addr ? addr.port : this.config.webhookPort;
    }
    return 0;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this._state === "connected" || this._state === "connecting") return;

    this.setState("connecting");

    // Validate token by calling getMe
    try {
      await this.apiCall<TelegramGetMeResult>("getMe");
    } catch (err) {
      this.setState("error");
      throw new ChannelConnectionError(this.name, `Failed to validate bot token: ${err}`);
    }

    if (this.config.mode === "webhook") {
      await this.connectWebhook();
    } else {
      await this.connectLongPolling();
    }

    this.setState("connected");
  }

  async disconnect(): Promise<void> {
    if (this.config.mode === "webhook") {
      await this.disconnectWebhook();
    } else {
      await this.disconnectLongPolling();
    }

    this.setState("disconnected");
  }

  getStatus(): ChannelStatus {
    return {
      state: this._state,
      message: `Telegram bot (${this.config.mode})`,
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
      chatId?: number | string;
      parseMode?: "MarkdownV2" | "HTML" | "Markdown";
      disableNotification?: boolean;
      replyToMessageId?: number;
    };

    const chatId = channelOpts.chatId;
    if (!chatId) {
      throw new ChannelSendError(this.name, "chatId is required in channelOptions");
    }

    const hasPhoto = options.attachments?.some((a) => a.type === "image");
    const hasDocument = options.attachments?.some((a) => a.type === "file");

    let result: TelegramSendMessageResult;

    if (hasPhoto) {
      const photoAttachment = options.attachments!.find((a) => a.type === "image")!;
      result = await this.apiCall<TelegramSendMessageResult>("sendPhoto", {
        chat_id: chatId,
        photo: photoAttachment.url,
        caption: options.content || undefined,
        parse_mode: channelOpts.parseMode,
        disable_notification: channelOpts.disableNotification,
        reply_to_message_id: options.replyTo ? Number(options.replyTo) : channelOpts.replyToMessageId,
      });
    } else if (hasDocument) {
      const docAttachment = options.attachments!.find((a) => a.type === "file")!;
      result = await this.apiCall<TelegramSendMessageResult>("sendDocument", {
        chat_id: chatId,
        document: docAttachment.url,
        caption: options.content || undefined,
        parse_mode: channelOpts.parseMode,
        disable_notification: channelOpts.disableNotification,
        reply_to_message_id: options.replyTo ? Number(options.replyTo) : channelOpts.replyToMessageId,
      });
    } else {
      result = await this.apiCall<TelegramSendMessageResult>("sendMessage", {
        chat_id: chatId,
        text: options.content,
        parse_mode: channelOpts.parseMode,
        disable_notification: channelOpts.disableNotification,
        reply_to_message_id: options.replyTo ? Number(options.replyTo) : channelOpts.replyToMessageId,
      });
    }

    const message: ChannelMessage = {
      id: String(result.message_id),
      channelType: this.channelType,
      senderId: "bot",
      content: options.content,
      attachments: options.attachments ?? [],
      replyTo: options.replyTo,
      timestamp: new Date(result.date * 1000).toISOString(),
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

  // ── Long Polling ───────────────────────────────────────────────────────────

  private async connectLongPolling(): Promise<void> {
    this.pollingAbortController = new AbortController();
    this.pollingPromise = this.runPollingLoop();
  }

  private async disconnectLongPolling(): Promise<void> {
    const controller = this.pollingAbortController;
    if (controller) {
      controller.abort();
    }
    if (this.pollingPromise) {
      await this.pollingPromise;
      this.pollingPromise = null;
    }
    this.pollingAbortController = null;
  }

  private async runPollingLoop(): Promise<void> {
    while (!this.pollingAbortController?.signal.aborted) {
      try {
        const updates = await this.getUpdates();
        if (this.pollingAbortController?.signal.aborted) break;
        for (const update of updates) {
          await this.processUpdate(update);
          this.pollingOffset = update.update_id + 1;
        }
        // Brief pause between empty polls to avoid tight-loop spin
        if (updates.length === 0 && !this.pollingAbortController?.signal.aborted) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 500);
            this.pollingAbortController?.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              resolve();
            }, { once: true });
          });
        }
      } catch (err) {
        if (this.pollingAbortController?.signal.aborted) break;
        // Back off on error before retrying
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 3000);
          this.pollingAbortController?.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
      }
    }
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const params: Record<string, unknown> = {
      offset: this.pollingOffset,
      timeout: this.config.pollingTimeout,
      allowed_updates: this.config.allowedUpdates,
    };

    const result = await this.apiCallWithAbort<TelegramUpdate[]>("getUpdates", params);
    return result ?? [];
  }

  // ── Webhook ────────────────────────────────────────────────────────────────

  private async connectWebhook(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.server = createServer((req, res) => this.handleWebhookRequest(req, res));

      this.server.on("error", (err) => {
        if (this._state === "connecting") {
          this.setState("error");
          reject(err);
        }
      });

      this.server.listen(this.config.webhookPort, this.config.webhookHost, async () => {
        const addr = this.server!.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : this.config.webhookPort;
        const webhookUrl = this.config.webhookUrl || `http://0.0.0.0:${actualPort}${this.config.webhookPath}`;

        try {
          await this.apiCall("setWebhook", {
            url: webhookUrl,
            allowed_updates: this.config.allowedUpdates,
          });
          resolve();
        } catch (err) {
          this.setState("error");
          reject(err);
        }
      });
    });
  }

  private async disconnectWebhook(): Promise<void> {
    try {
      await this.apiCall("deleteWebhook");
    } catch {
      // Ignore errors during cleanup
    }

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => {
          this.server = null;
          resolve();
        });
      });
    }
  }

  private async handleWebhookRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${this.config.webhookPort}`);
    if (url.pathname !== this.config.webhookPath) {
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

      const update: TelegramUpdate = JSON.parse(body.toString("utf-8"));

      // Respond immediately
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));

      await this.processUpdate(update);
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

  // ── Update Processing ─────────────────────────────────────────────────────

  private async processUpdate(update: TelegramUpdate): Promise<void> {
    const msg = update.message ?? update.edited_message ?? update.channel_post;
    if (!msg) return;

    const message = this.parseMessage(msg);
    if (!message) return;

    this.history.push(message);
    this.receivedCount++;

    for (const cb of this.callbacks) {
      await cb(message);
    }
  }

  private parseMessage(msg: TelegramMessage): ChannelMessage | null {
    const senderId = msg.from ? String(msg.from.id) : String(msg.chat.id);
    const senderName = msg.from
      ? [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ")
      : msg.chat.title ?? "unknown";

    let content = msg.text ?? msg.caption ?? "";
    const attachments: ChannelAttachment[] = [];

    if (msg.photo && msg.photo.length > 0) {
      // Use the largest photo
      const largest = msg.photo[msg.photo.length - 1];
      attachments.push({
        type: "image",
        url: `telegram://file/${largest.file_id}`,
      });
      if (!content) content = "[photo]";
    }

    if (msg.document) {
      attachments.push({
        type: "file",
        url: `telegram://file/${msg.document.file_id}`,
        name: msg.document.file_name,
        mimeType: msg.document.mime_type,
      });
      if (!content) content = `[document: ${msg.document.file_name ?? "unknown"}]`;
    }

    if (msg.sticker) {
      content = `[sticker: ${msg.sticker.emoji ?? "?"}]`;
    }

    if (msg.voice) {
      attachments.push({
        type: "audio",
        url: `telegram://file/${msg.voice.file_id}`,
        mimeType: msg.voice.mime_type,
      });
      if (!content) content = "[voice]";
    }

    if (msg.video) {
      attachments.push({
        type: "video",
        url: `telegram://file/${msg.video.file_id}`,
        mimeType: msg.video.mime_type,
      });
      if (!content) content = "[video]";
    }

    if (msg.location) {
      content = `[location: ${msg.location.latitude},${msg.location.longitude}]`;
    }

    if (!content && attachments.length === 0) return null;

    return {
      id: String(msg.message_id),
      channelType: this.channelType,
      senderId,
      senderName,
      content,
      attachments,
      replyTo: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
      timestamp: new Date(msg.date * 1000).toISOString(),
      raw: {
        chatId: msg.chat.id,
        chatType: msg.chat.type,
        chatTitle: msg.chat.title,
      },
    };
  }

  // ── API Helpers ────────────────────────────────────────────────────────────

  private async apiCall<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const url = `${this.config.apiBaseUrl}/bot${this.config.botToken}/${method}`;
    const body = params ? JSON.stringify(params) : undefined;

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    const data = await resp.json() as TelegramApiResponse<T>;
    if (!data.ok) {
      throw new Error(`Telegram API ${method} failed: ${data.description ?? "unknown error"} (code: ${data.error_code})`);
    }

    return data.result!;
  }

  private async apiCallWithAbort<T>(method: string, params?: Record<string, unknown>): Promise<T | null> {
    const url = `${this.config.apiBaseUrl}/bot${this.config.botToken}/${method}`;
    const body = params ? JSON.stringify(params) : undefined;

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: this.pollingAbortController?.signal,
    });

    if (this.pollingAbortController?.signal.aborted) return null;

    const data = await resp.json() as TelegramApiResponse<T>;
    if (!data.ok) {
      throw new Error(`Telegram API ${method} failed: ${data.description ?? "unknown error"} (code: ${data.error_code})`);
    }

    return data.result ?? null;
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private setState(state: ConnectionState): void {
    this._state = state;
    this.stateChangedAt = new Date().toISOString();
  }
}
