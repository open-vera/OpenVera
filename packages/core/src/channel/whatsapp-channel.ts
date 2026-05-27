/**
 * WhatsApp Business API Channel Adapter — WhatsApp Cloud API integration.
 *
 * Implements the ChannelAdapter interface for WhatsApp Business using the
 * WhatsApp Cloud API (Meta Business Platform).
 *
 * Features:
 *   - Webhook server for receiving messages (HTTP GET verification + POST events)
 *   - WhatsApp Cloud API for sending messages
 *   - Message types: text, image, document, audio, video, location, template
 *   - Access token management (permanent or temporary tokens)
 *   - Webhook signature verification (X-Hub-Signature-256)
 *   - Contact resolution from webhook payloads
 */

import { createHmac } from "node:crypto";
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

export interface WhatsAppChannelConfig {
  /** WhatsApp Cloud API access token (permanent or temporary) */
  accessToken: string;
  /** Phone number ID from Meta Business (used in API endpoints) */
  phoneNumberId: string;
  /** WhatsApp Business Account ID */
  businessAccountId: string;
  /** Verification token for webhook setup (must match Meta dashboard) */
  verifyToken: string;
  /** Webhook server host (default: "0.0.0.0") */
  host?: string;
  /** Webhook server port (default: 0 = auto-assign) */
  port?: number;
  /** Webhook path (default: "/whatsapp/webhook") */
  path?: string;
  /** WhatsApp Cloud API base URL (default: "https://graph.facebook.com/v18.0") */
  apiBaseUrl?: string;
  /** Custom message ID generator */
  generateId?: () => string;
  /** Maximum request body size in bytes (default: 2MB) */
  maxBodyBytes?: number;
  /** Optional app secret for X-Hub-Signature-256 verification */
  appSecret?: string;
}

interface WhatsAppInternalConfig {
  accessToken: string;
  phoneNumberId: string;
  businessAccountId: string;
  verifyToken: string;
  host: string;
  port: number;
  path: string;
  apiBaseUrl: string;
  generateId: () => string;
  maxBodyBytes: number;
  appSecret: string | null;
}

const DEFAULT_CONFIG = {
  host: "0.0.0.0",
  port: 0,
  path: "/whatsapp/webhook",
  apiBaseUrl: "https://graph.facebook.com/v18.0",
  maxBodyBytes: 2_097_152,
};

// ── WhatsApp Cloud API Types ──────────────────────────────────────────────────

interface WhatsAppContact {
  wa_id: string;
  profile: {
    name?: string;
  };
}

interface WhatsAppTextMessage {
  type: "text";
  text: {
    body: string;
  };
}

interface WhatsAppImageMessage {
  type: "image";
  image: {
    id: string;
    mime_type: string;
    sha256: string;
    caption?: string;
  };
}

interface WhatsAppDocumentMessage {
  type: "document";
  document: {
    id: string;
    mime_type: string;
    sha256: string;
    filename?: string;
    caption?: string;
  };
}

interface WhatsAppAudioMessage {
  type: "audio";
  audio: {
    id: string;
    mime_type: string;
    sha256: string;
    voice?: boolean;
  };
}

interface WhatsAppVideoMessage {
  type: "video";
  video: {
    id: string;
    mime_type: string;
    sha256: string;
    caption?: string;
  };
}

interface WhatsAppLocationMessage {
  type: "location";
  location: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };
}

interface WhatsAppReactionMessage {
  type: "reaction";
  reaction: {
    message_id: string;
    emoji: string;
  };
}

type WhatsAppMessageBody =
  | WhatsAppTextMessage
  | WhatsAppImageMessage
  | WhatsAppDocumentMessage
  | WhatsAppAudioMessage
  | WhatsAppVideoMessage
  | WhatsAppLocationMessage
  | WhatsAppReactionMessage;

interface WhatsAppMessageBase {
  from: string;
  id: string;
  timestamp: string;
  context?: {
    message_id?: string;
  };
}

type WhatsAppIncomingMessage = WhatsAppMessageBase & WhatsAppMessageBody;

interface WhatsAppStatus {
  id: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: string;
  recipient_id: string;
  errors?: Array<{ code: number; title: string; message: string }>;
}

interface WhatsAppWebhookChangeValue {
  messaging_product: "whatsapp";
  metadata: {
    display_phone_number: string;
    phone_number_id: string;
  };
  contacts?: WhatsAppContact[];
  messages?: WhatsAppIncomingMessage[];
  statuses?: WhatsAppStatus[];
}

interface WhatsAppWebhookChange {
  value: WhatsAppWebhookChangeValue;
  field: "messages";
}

interface WhatsAppWebhookEntry {
  id: string;
  changes: WhatsAppWebhookChange[];
}

interface WhatsAppWebhookPayload {
  object: "whatsapp_business_account";
  entry: WhatsAppWebhookEntry[];
}

interface WhatsAppSendMessageResponse {
  messaging_product: "whatsapp";
  contacts: Array<{ input: string; wa_id: string }>;
  messages: Array<{ id: string }>;
}

interface WhatsAppApiError {
  error: {
    message: string;
    type: string;
    code: number;
    error_subcode?: number;
    fbtrace_id: string;
  };
}

// ── WhatsApp Channel Adapter ──────────────────────────────────────────────────

export class WhatsAppChannelAdapter implements ChannelAdapter {
  readonly name = "whatsapp";
  readonly channelType = "whatsapp" as const;

  private _state: ConnectionState = "disconnected";
  private config: WhatsAppInternalConfig;
  private server: Server | null = null;
  private callbacks: MessageCallback[] = [];
  private history: ChannelMessage[] = [];
  private sentCount = 0;
  private receivedCount = 0;
  private stateChangedAt: string = new Date().toISOString();
  private actualPort = 0;

  constructor(config: WhatsAppChannelConfig) {
    if (!config.accessToken) throw new Error("WhatsAppChannelConfig.accessToken is required");
    if (!config.phoneNumberId) throw new Error("WhatsAppChannelConfig.phoneNumberId is required");
    if (!config.businessAccountId) throw new Error("WhatsAppChannelConfig.businessAccountId is required");
    if (!config.verifyToken) throw new Error("WhatsAppChannelConfig.verifyToken is required");

    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      generateId: config.generateId ?? (() => `wa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
      appSecret: config.appSecret ?? null,
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

    // Validate token by fetching phone number info
    try {
      await this.validateToken();
    } catch (err) {
      this.setState("error");
      throw new ChannelConnectionError(this.name, `Failed to validate access token: ${err}`);
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
      message: `WhatsApp Cloud API on port ${this.actualPort}, path ${this.config.path}`,
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
      to?: string;
      messageType?: "text" | "image" | "document" | "audio" | "video" | "location" | "template";
      /** Media ID for image/document/audio/video messages */
      mediaId?: string;
      /** Media URL for image/document/audio/video messages */
      mediaUrl?: string;
      /** Caption for media messages */
      caption?: string;
      /** Filename for document messages */
      filename?: string;
      /** Location latitude */
      latitude?: number;
      /** Location longitude */
      longitude?: number;
      /** Location name */
      locationName?: string;
      /** Location address */
      locationAddress?: string;
      /** Template name for template messages */
      templateName?: string;
      /** Template language code */
      templateLanguage?: string;
      /** Template parameters */
      templateParams?: Array<{ type: string; text: string }>;
    };

    const to = channelOpts.to;
    if (!to) {
      throw new ChannelSendError(this.name, "to (recipient phone number) is required in channelOptions");
    }

    const messageType = channelOpts.messageType ?? "text";
    const body = this.buildMessageBody(options.content, messageType, channelOpts);

    const url = `${this.config.apiBaseUrl}/${this.config.phoneNumberId}/messages`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.accessToken}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errorData = await resp.json().catch(() => null) as WhatsAppApiError | null;
      const detail = errorData?.error?.message ?? `HTTP ${resp.status}`;
      throw new ChannelSendError(this.name, `WhatsApp API error: ${detail}`);
    }

    const data = await resp.json() as WhatsAppSendMessageResponse;
    const messageId = data.messages[0]?.id ?? this.config.generateId();

    const message: ChannelMessage = {
      id: messageId,
      channelType: this.channelType,
      senderId: "bot",
      content: options.content,
      attachments: options.attachments ?? [],
      replyTo: options.replyTo,
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
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Hub-Signature-256");

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

    // GET = webhook verification request from Meta
    if (req.method === "GET") {
      this.handleVerification(url, res);
      return;
    }

    // POST = incoming message/status webhook event
    if (req.method === "POST") {
      await this.handleWebhookEvent(req, res);
      return;
    }

    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  /**
   * Handle Meta webhook verification (GET request).
   *
   * Meta sends: hub.mode=subscribe, hub.challenge=<random>, hub.verify_token=<token>
   * We respond with hub.challenge if verify_token matches.
   */
  private handleVerification(url: URL, res: ServerResponse): void {
    const mode = url.searchParams.get("hub.mode");
    const challenge = url.searchParams.get("hub.challenge");
    const token = url.searchParams.get("hub.verify_token");

    if (mode === "subscribe" && token === this.config.verifyToken) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(challenge ?? "");
    } else {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Verification failed");
    }
  }

  /** Handle incoming webhook event (POST request) */
  private async handleWebhookEvent(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.readBody(req);
      if (!body) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Empty body");
        return;
      }

      // Verify signature if appSecret is configured
      if (this.config.appSecret) {
        const signature = req.headers["x-hub-signature-256"] as string | undefined;
        if (!signature || !this.verifySignature(body, signature)) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Invalid signature");
          return;
        }
      }

      // Respond immediately (WhatsApp requires fast response)
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");

      // Process event asynchronously
      const payload = JSON.parse(body.toString("utf-8")) as WhatsAppWebhookPayload;
      await this.processWebhookPayload(payload);
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

  private verifySignature(body: Buffer, signatureHeader: string): boolean {
    if (!this.config.appSecret) return true;

    const expectedSignature = `sha256=${createHmac("sha256", this.config.appSecret).update(body).digest("hex")}`;
    return signatureHeader === expectedSignature;
  }

  // ── Webhook Payload Processing ─────────────────────────────────────────────

  private async processWebhookPayload(payload: WhatsAppWebhookPayload): Promise<void> {
    if (payload.object !== "whatsapp_business_account") return;

    for (const entry of payload.entry) {
      for (const change of entry.changes) {
        if (change.field !== "messages") continue;

        const { contacts, messages } = change.value;

        if (messages) {
          for (const msg of messages) {
            const contact = contacts?.find((c) => c.wa_id === msg.from);
            await this.processMessage(msg, contact);
          }
        }
      }
    }
  }

  private async processMessage(msg: WhatsAppIncomingMessage, contact?: WhatsAppContact): Promise<void> {
    const senderId = msg.from;
    const senderName = contact?.profile?.name;

    let content = "";
    const attachments: ChannelAttachment[] = [];

    switch (msg.type) {
      case "text":
        content = msg.text.body;
        break;

      case "image":
        content = msg.image.caption ?? "[image]";
        attachments.push({
          type: "image",
          url: `whatsapp://media/${msg.image.id}`,
          mimeType: msg.image.mime_type,
        });
        break;

      case "document":
        content = msg.document.caption ?? `[document: ${msg.document.filename ?? "unknown"}]`;
        attachments.push({
          type: "file",
          url: `whatsapp://media/${msg.document.id}`,
          name: msg.document.filename,
          mimeType: msg.document.mime_type,
        });
        break;

      case "audio":
        content = "[audio]";
        attachments.push({
          type: "audio",
          url: `whatsapp://media/${msg.audio.id}`,
          mimeType: msg.audio.mime_type,
        });
        break;

      case "video":
        content = msg.video.caption ?? "[video]";
        attachments.push({
          type: "video",
          url: `whatsapp://media/${msg.video.id}`,
          mimeType: msg.video.mime_type,
        });
        break;

      case "location":
        content = `[location: ${msg.location.latitude},${msg.location.longitude}]`;
        if (msg.location.name) content += ` ${msg.location.name}`;
        if (msg.location.address) content += ` (${msg.location.address})`;
        break;

      case "reaction":
        content = `[reaction: ${msg.reaction.emoji}]`;
        break;

      default:
        content = `[unsupported message type: ${(msg as WhatsAppMessageBase & { type: string }).type}]`;
    }

    const message: ChannelMessage = {
      id: msg.id,
      channelType: this.channelType,
      senderId,
      senderName,
      content,
      attachments,
      replyTo: msg.context?.message_id,
      timestamp: new Date(Number(msg.timestamp) * 1000).toISOString(),
      raw: {
        messageType: msg.type,
        phoneNumberId: this.config.phoneNumberId,
      },
    };

    this.history.push(message);
    this.receivedCount++;

    for (const cb of this.callbacks) {
      await cb(message);
    }
  }

  // ── Message Body Builder ──────────────────────────────────────────────────

  private buildMessageBody(
    content: string,
    messageType: string,
    opts: Record<string, unknown>,
  ): Record<string, unknown> {
    const base = {
      messaging_product: "whatsapp" as const,
      recipient_type: "individual" as const,
      to: opts.to as string,
    };

    switch (messageType) {
      case "text":
        return {
          ...base,
          type: "text",
          text: { body: content, preview_url: false },
        };

      case "image": {
        const imageObj: Record<string, unknown> = {};
        if (opts.mediaId) {
          imageObj.id = opts.mediaId;
        } else if (opts.mediaUrl) {
          imageObj.link = opts.mediaUrl;
        }
        if (content || opts.caption) {
          imageObj.caption = (content || opts.caption) as string;
        }
        return { ...base, type: "image", image: imageObj };
      }

      case "document": {
        const docObj: Record<string, unknown> = {};
        if (opts.mediaId) {
          docObj.id = opts.mediaId;
        } else if (opts.mediaUrl) {
          docObj.link = opts.mediaUrl;
        }
        if (opts.filename) {
          docObj.filename = opts.filename;
        }
        if (content || opts.caption) {
          docObj.caption = (content || opts.caption) as string;
        }
        return { ...base, type: "document", document: docObj };
      }

      case "audio": {
        const audioObj: Record<string, unknown> = {};
        if (opts.mediaId) {
          audioObj.id = opts.mediaId;
        } else if (opts.mediaUrl) {
          audioObj.link = opts.mediaUrl;
        }
        return { ...base, type: "audio", audio: audioObj };
      }

      case "video": {
        const videoObj: Record<string, unknown> = {};
        if (opts.mediaId) {
          videoObj.id = opts.mediaId;
        } else if (opts.mediaUrl) {
          videoObj.link = opts.mediaUrl;
        }
        if (content || opts.caption) {
          videoObj.caption = (content || opts.caption) as string;
        }
        return { ...base, type: "video", video: videoObj };
      }

      case "location": {
        return {
          ...base,
          type: "location",
          location: {
            latitude: opts.latitude ?? 0,
            longitude: opts.longitude ?? 0,
            name: opts.locationName,
            address: opts.locationAddress,
          },
        };
      }

      case "template": {
        return {
          ...base,
          type: "template",
          template: {
            name: opts.templateName as string,
            language: {
              code: opts.templateLanguage ?? "en",
            },
            components: opts.templateParams
              ? [{ type: "body", parameters: opts.templateParams }]
              : [],
          },
        };
      }

      default:
        return {
          ...base,
          type: "text",
          text: { body: content, preview_url: false },
        };
    }
  }

  // ── Token Validation ──────────────────────────────────────────────────────

  private async validateToken(): Promise<void> {
    const url = `${this.config.apiBaseUrl}/${this.config.phoneNumberId}`;
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
      },
    });

    if (!resp.ok) {
      const errorData = await resp.json().catch(() => null) as WhatsAppApiError | null;
      const detail = errorData?.error?.message ?? `HTTP ${resp.status}`;
      throw new Error(detail);
    }
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private setState(state: ConnectionState): void {
    this._state = state;
    this.stateChangedAt = new Date().toISOString();
  }
}
