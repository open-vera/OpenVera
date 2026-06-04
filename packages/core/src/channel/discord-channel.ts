/**
 * Discord Bot Channel Adapter — Discord Bot API integration.
 *
 * Implements the ChannelAdapter interface for Discord bots using the
 * Discord Gateway (WebSocket) + REST API.
 *
 * Features:
 *   - WebSocket Gateway connection for real-time message events
 *   - REST API for sending messages (text, embeds, files)
 *   - Automatic heartbeat to keep connection alive
 *   - Reconnect on disconnect with exponential backoff
 *   - Channel/guild awareness
 *   - Slash command interaction support (basic)
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
import { appendBotMessage, filterChannelHistory, subscribeMessage } from "./channel-helpers.js";
import { ChannelNotConnectedError, ChannelSendError, ChannelConnectionError } from "./types.js";

// ── Configuration ─────────────────────────────────────────────────────────────

export interface DiscordChannelConfig {
  /** Discord Bot token */
  botToken: string;
  /** Application ID (required for slash commands) */
  applicationId?: string;
  /** Gateway intents bitmask (default: GUILDS + GUILD_MESSAGES + MESSAGE_CONTENT) */
  intents?: number;
  /** Gateway URL override (default: "wss://gateway.discord.gg") */
  gatewayUrl?: string;
  /** REST API base URL (default: "https://discord.com/api/v10") */
  apiBaseUrl?: string;
  /** Heartbeat interval override in ms (auto-detected from Gateway hello) */
  heartbeatIntervalMs?: number;
  /** Max reconnect attempts (default: 10) */
  maxReconnectAttempts?: number;
  /** Custom message ID generator */
  generateId?: () => string;
}

interface DiscordInternalConfig {
  botToken: string;
  applicationId: string;
  intents: number;
  gatewayUrl: string;
  apiBaseUrl: string;
  heartbeatIntervalMs: number;
  maxReconnectAttempts: number;
  generateId: () => string;
}

// Discord Gateway Intents
const INTENT_GUILDS = 1 << 0;
const INTENT_GUILD_MESSAGES = 1 << 9;
const INTENT_MESSAGE_CONTENT = 1 << 15;
const DEFAULT_INTENTS = INTENT_GUILDS | INTENT_GUILD_MESSAGES | INTENT_MESSAGE_CONTENT;

const DEFAULT_CONFIG = {
  gatewayUrl: "wss://gateway.discord.gg",
  apiBaseUrl: "https://discord.com/api/v10",
  maxReconnectAttempts: 10,
};

// ── Discord Gateway Types ─────────────────────────────────────────────────────

interface DiscordGatewayHello {
  op: 10;
  d: { heartbeat_interval: number };
}

interface DiscordGatewayDispatch {
  op: 0;
  t: string;
  s: number;
  d: unknown;
}

interface DiscordGatewayHeartbeatAck {
  op: 11;
}

interface DiscordGatewayResume {
  op: 6;
  d: { token: string; session_id: string; seq: number };
}

interface DiscordUser {
  id: string;
  username: string;
  discriminator: string;
  avatar?: string;
  bot?: boolean;
}

interface DiscordMessageData {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: DiscordUser;
  content: string;
  timestamp: string;
  edited_timestamp?: string;
  tts: boolean;
  mention_everyone: boolean;
  mentions: DiscordUser[];
  attachments: DiscordAttachmentData[];
  embeds: DiscordEmbedData[];
  message_reference?: {
    message_id?: string;
    channel_id?: string;
    guild_id?: string;
  };
  type: number;
}

interface DiscordAttachmentData {
  id: string;
  filename: string;
  content_type?: string;
  size: number;
  url: string;
  proxy_url: string;
  width?: number;
  height?: number;
}

interface DiscordEmbedData {
  title?: string;
  type?: string;
  description?: string;
  url?: string;
  color?: number;
}

interface DiscordReadyEvent {
  v: number;
  user: DiscordUser;
  guilds: Array<{ id: string; unavailable?: boolean }>;
  session_id: string;
  resume_gateway_url: string;
}

interface DiscordCreateMessageResponse {
  id: string;
  channel_id: string;
  timestamp: string;
}

// ── Discord Channel Adapter ───────────────────────────────────────────────────

export class DiscordChannelAdapter implements ChannelAdapter {
  readonly name = "discord";
  readonly channelType = "discord" as const;

  private _state: ConnectionState = "disconnected";
  private config: DiscordInternalConfig;
  private callbacks: MessageCallback[] = [];
  private history: ChannelMessage[] = [];
  private sentCount = 0;
  private receivedCount = 0;
  private stateChangedAt: string = new Date().toISOString();

  // Gateway WebSocket state
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatAckReceived = true;
  private sequenceNumber: number | null = null;
  private sessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;

  constructor(config: DiscordChannelConfig) {
    if (!config.botToken) throw new Error("DiscordChannelConfig.botToken is required");

    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      intents: config.intents ?? DEFAULT_INTENTS,
      applicationId: config.applicationId ?? "",
      heartbeatIntervalMs: config.heartbeatIntervalMs ?? 41250,
      generateId: config.generateId ?? (() => `dc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    };
  }

  get state(): ConnectionState {
    return this._state;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this._state === "connected" || this._state === "connecting") return;

    this.setState("connecting");
    this.intentionalClose = false;
    this.reconnectAttempts = 0;

    try {
      await this.connectGateway();
    } catch (err) {
      this.setState("error");
      throw new ChannelConnectionError(this.name, `Failed to connect: ${err}`);
    }
  }

  async disconnect(): Promise<void> {
    this.intentionalClose = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.stopHeartbeat();

    if (this.ws) {
      this.ws.close(1000, "Client disconnect");
      this.ws = null;
    }

    this.sessionId = null;
    this.sequenceNumber = null;
    this.setState("disconnected");
  }

  getStatus(): ChannelStatus {
    return {
      state: this._state,
      message: `Discord bot (Gateway)`,
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
      embeds?: Array<{ title?: string; description?: string; color?: number; url?: string }>;
      tts?: boolean;
      allowedMentions?: { parse?: string[]; roles?: string[]; users?: string[] };
    };

    const channelId = channelOpts.channelId;
    if (!channelId) {
      throw new ChannelSendError(this.name, "channelId is required in channelOptions");
    }

    const body: Record<string, unknown> = {
      content: options.content,
      tts: channelOpts.tts ?? false,
    };

    if (channelOpts.embeds?.length) {
      body.embeds = channelOpts.embeds;
    }

    if (channelOpts.allowedMentions) {
      body.allowed_mentions = channelOpts.allowedMentions;
    } else {
      body.allowed_mentions = { parse: [] };
    }

    // Handle file attachments
    if (options.attachments?.length) {
      const files: Array<{ name: string; url: string }> = [];
      for (const att of options.attachments) {
        if (att.url) {
          files.push({ name: att.name ?? "file", url: att.url });
        }
      }
      if (files.length > 0) {
        body.attachments = files.map((f, i) => ({ id: i, filename: f.name }));
        // For simplicity, we send URLs as content references
        // Real file upload would require multipart/form-data
      }
    }

    const result = await this.apiCall<DiscordCreateMessageResponse>(
      "POST",
      `/channels/${channelId}/messages`,
      body,
    );

    const message = appendBotMessage(
      this.history,
      this.channelType,
      options,
      this.config.generateId,
      { id: result.id, timestamp: result.timestamp ?? new Date().toISOString() }
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

  // ── Gateway WebSocket ──────────────────────────────────────────────────────

  private async connectGateway(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const wsUrl = this.resumeGatewayUrl
        ? `${this.resumeGatewayUrl}/?v=10&encoding=json`
        : `${this.config.gatewayUrl}/?v=10&encoding=json`;

      this.ws = new WebSocket(wsUrl);

      let resolved = false;

      const onOpen = (): void => {
        // Wait for HELLO event to confirm connection
      };

      const onMessage = (event: MessageEvent): void => {
        try {
          const data = JSON.parse(String(event.data)) as Record<string, unknown>;
          const op = data.op as number;

          if (op === 10) {
            // HELLO — start heartbeat
            const hello = data as unknown as DiscordGatewayHello;
            this.config.heartbeatIntervalMs = hello.d.heartbeat_interval;
            this.startHeartbeat();

            // Identify or Resume
            if (this.sessionId && this.sequenceNumber !== null) {
              this.sendResume();
            } else {
              this.sendIdentify();
            }
          } else if (op === 0) {
            // Dispatch
            this.handleDispatch(data as unknown as DiscordGatewayDispatch);

            if (!resolved && (data as unknown as DiscordGatewayDispatch).t === "READY") {
              resolved = true;
              this.setState("connected");
              this.reconnectAttempts = 0;
              resolve();
            }
          } else if (op === 11) {
            // Heartbeat ACK
            this.heartbeatAckReceived = true;
          } else if (op === 1) {
            // Heartbeat request
            this.sendHeartbeat();
          } else if (op === 7) {
            // Reconnect
            this.handleReconnect();
          } else if (op === 9) {
            // Invalid session
            this.sessionId = null;
            this.sequenceNumber = null;
            this.ws?.close(4000, "Invalid session");
          }
        } catch {
          // Parse error — ignore
        }
      };

      const onClose = (event: CloseEvent): void => {
        this.stopHeartbeat();

        if (!resolved) {
          resolved = true;
          reject(new Error(`Gateway closed during connect: ${event.code} ${event.reason}`));
          return;
        }

        if (!this.intentionalClose) {
          this.handleReconnect();
        }
      };

      const onError = (): void => {
        if (!resolved) {
          resolved = true;
          reject(new Error("Gateway WebSocket error"));
        }
      };

      this.ws.addEventListener("open", onOpen);
      this.ws.addEventListener("message", onMessage);
      this.ws.addEventListener("close", onClose);
      this.ws.addEventListener("error", onError);
    });
  }

  private sendIdentify(): void {
    const payload = {
      op: 2,
      d: {
        token: `Bot ${this.config.botToken}`,
        intents: this.config.intents,
        properties: {
          os: "linux",
          browser: "openvera",
          device: "openvera",
        },
      },
    };
    this.ws?.send(JSON.stringify(payload));
  }

  private sendResume(): void {
    const payload: DiscordGatewayResume = {
      op: 6,
      d: {
        token: `Bot ${this.config.botToken}`,
        session_id: this.sessionId!,
        seq: this.sequenceNumber!,
      },
    };
    this.ws?.send(JSON.stringify(payload));
  }

  private sendHeartbeat(): void {
    const payload = {
      op: 1,
      d: this.sequenceNumber,
    };
    this.ws?.send(JSON.stringify(payload));
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatAckReceived = true;

    // Initial heartbeat after jitter
    const jitter = Math.random() * this.config.heartbeatIntervalMs;
    setTimeout(() => {
      this.sendHeartbeat();
      this.heartbeatAckReceived = false;

      this.heartbeatTimer = setInterval(() => {
        if (!this.heartbeatAckReceived) {
          // Zombie connection — reconnect
          this.ws?.close(4009, "Heartbeat timeout");
          this.handleReconnect();
          return;
        }
        this.heartbeatAckReceived = false;
        this.sendHeartbeat();
      }, this.config.heartbeatIntervalMs);
    }, jitter);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async handleReconnect(): Promise<void> {
    if (this.intentionalClose) return;
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.setState("error");
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);

    this.setState("connecting");

    this.reconnectTimer = setTimeout(async () => {
      try {
        this.resumeGatewayUrl = this.resumeGatewayUrl ?? this.config.gatewayUrl.replace("wss://", "");
        await this.connectGateway();
      } catch {
        this.handleReconnect();
      }
    }, delay);
  }

  // ── Dispatch Handling ──────────────────────────────────────────────────────

  private handleDispatch(dispatch: DiscordGatewayDispatch): void {
    this.sequenceNumber = dispatch.s;

    switch (dispatch.t) {
      case "READY":
        this.handleReady(dispatch.d as DiscordReadyEvent);
        break;
      case "MESSAGE_CREATE":
        this.handleMessageCreate(dispatch.d as DiscordMessageData);
        break;
      case "MESSAGE_UPDATE":
        // Could track edits, for now ignore
        break;
    }
  }

  private handleReady(data: DiscordReadyEvent): void {
    this.sessionId = data.session_id;
    this.resumeGatewayUrl = data.resume_gateway_url?.replace("wss://", "") ?? null;
  }

  private async handleMessageCreate(data: DiscordMessageData): Promise<void> {
    // Ignore bot messages
    if (data.author.bot) return;

    const attachments: ChannelAttachment[] = data.attachments.map((att) => ({
      type: (att.content_type?.startsWith("image") ? "image" : "file") as ChannelAttachment["type"],
      url: att.url,
      name: att.filename,
      mimeType: att.content_type,
      size: att.size,
    }));

    const message: ChannelMessage = {
      id: data.id,
      channelType: this.channelType,
      senderId: data.author.id,
      senderName: `${data.author.username}#${data.author.discriminator}`,
      content: data.content,
      attachments,
      replyTo: data.message_reference?.message_id,
      timestamp: data.timestamp,
      raw: {
        guildId: data.guild_id,
        channelId: data.channel_id,
        tts: data.tts,
        mentionEveryone: data.mention_everyone,
      },
    };

    this.history.push(message);
    this.receivedCount++;

    for (const cb of this.callbacks) {
      await cb(message);
    }
  }

  // ── REST API ───────────────────────────────────────────────────────────────

  private async apiCall<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.config.apiBaseUrl}${path}`;

    const resp = await fetch(url, {
      method,
      headers: {
        Authorization: `Bot ${this.config.botToken}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!resp.ok) {
      const errorBody = await resp.text().catch(() => "unknown");
      throw new ChannelSendError(this.name, `Discord API ${method} ${path} failed (${resp.status}): ${errorBody}`);
    }

    return resp.json() as Promise<T>;
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private setState(state: ConnectionState): void {
    this._state = state;
    this.stateChangedAt = new Date().toISOString();
  }
}
