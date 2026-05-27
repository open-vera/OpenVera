/**
 * API Channel Adapter — REST HTTP + WebSocket API for external system integration.
 * Implements the ChannelAdapter interface.
 *
 * REST endpoints:
 *   POST /messages          — send a message to the agent
 *   GET  /messages          — retrieve message history
 *   GET  /status            — connection status
 *
 * WebSocket:
 *   Clients connect and exchange JSON messages bidirectionally.
 */

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type {
  ChannelAdapter,
  ChannelMessage,
  ChannelStatus,
  ConnectionState,
  HistoryOptions,
  MessageCallback,
  SendMessageOptions,
} from "./types.js";
import { ChannelNotConnectedError, ChannelSendError } from "./types.js";

/** Configuration for the API Channel Adapter */
export interface ApiChannelConfig {
  /** Host to bind (default: "0.0.0.0") */
  host?: string;
  /** Port to listen on (default: 0 = auto-assign) */
  port?: number;
  /** Sender ID for incoming REST/WS messages */
  senderId?: string;
  /** Custom message ID generator */
  generateId?: () => string;
  /** Optional API key for authentication */
  apiKey?: string;
  /** Maximum request body size in bytes (default: 1MB) */
  maxBodyBytes?: number;
}

interface WsClient {
  socket: import("node:net").Socket;
  alive: boolean;
}

const DEFAULT_CONFIG: Required<Omit<ApiChannelConfig, "generateId" | "apiKey">> & {
  generateId: () => string;
  apiKey?: string;
} = {
  host: "0.0.0.0",
  port: 0,
  senderId: "api-client",
  generateId: () => `api-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  maxBodyBytes: 1_048_576,
};

export class ApiChannelAdapter implements ChannelAdapter {
  readonly name = "api";
  readonly channelType = "api" as const;

  private _state: ConnectionState = "disconnected";
  private config: typeof DEFAULT_CONFIG;
  private server: Server | null = null;
  private callbacks: MessageCallback[] = [];
  private history: ChannelMessage[] = [];
  private sentCount = 0;
  private receivedCount = 0;
  private stateChangedAt: string = new Date().toISOString();
  private wsClients: Set<WsClient> = new Set();
  private actualPort = 0;

  constructor(config?: ApiChannelConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
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

    return new Promise<void>((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));

      this.server.on("upgrade", (req, socket, head) => {
        this.handleUpgrade(req, socket as import("node:net").Socket, head);
      });

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

    // Close all WebSocket clients
    for (const client of this.wsClients) {
      this.closeWsClient(client);
    }
    this.wsClients.clear();

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
      message: `API channel on port ${this.actualPort}, ${this.wsClients.size} WS clients`,
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

    // Broadcast to all connected WebSocket clients
    this.broadcastWs({ type: "message", data: message });

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
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // API key check
    if (this.config.apiKey) {
      const authHeader = req.headers.authorization;
      const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
      if (token !== this.config.apiKey) {
        this.jsonResponse(res, 401, { error: "Unauthorized" });
        return;
      }
    }

    const url = new URL(req.url ?? "/", `http://localhost:${this.actualPort}`);

    try {
      if (req.method === "GET" && url.pathname === "/status") {
        this.jsonResponse(res, 200, this.getStatus());
      } else if (req.method === "GET" && url.pathname === "/messages") {
        const options: HistoryOptions = {};
        if (url.searchParams.has("limit")) options.limit = Number(url.searchParams.get("limit"));
        if (url.searchParams.has("after")) options.after = url.searchParams.get("after")!;
        if (url.searchParams.has("before")) options.before = url.searchParams.get("before")!;
        if (url.searchParams.has("senderId")) options.senderId = url.searchParams.get("senderId")!;
        const messages = await this.getHistory(options);
        this.jsonResponse(res, 200, { messages });
      } else if (req.method === "POST" && url.pathname === "/messages") {
        const body = await this.readBody(req);
        if (!body || typeof body.content !== "string" || !body.content.trim()) {
          this.jsonResponse(res, 400, { error: "Missing or empty 'content' field" });
          return;
        }
        const senderId = typeof body.senderId === "string" ? body.senderId : undefined;
        const message = await this.createAndDispatch(body.content.trim(), senderId);
        this.jsonResponse(res, 201, { message });
      } else {
        this.jsonResponse(res, 404, { error: "Not found" });
      }
    } catch (err) {
      this.jsonResponse(res, 500, { error: String(err) });
    }
  }

  private readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
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
        if (chunks.length === 0) {
          resolve(null);
          return;
        }
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          resolve(body);
        } catch {
          reject(new Error("Invalid JSON"));
        }
      });

      req.on("error", reject);
    });
  }

  private jsonResponse(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  // ── WebSocket Handling (RFC 6455 minimal implementation) ───────────────────

  private handleUpgrade(req: IncomingMessage, socket: import("node:net").Socket, head: Buffer): void {
    // API key check for WebSocket
    if (this.config.apiKey) {
      const url = new URL(req.url ?? "/", `http://localhost:${this.actualPort}`);
      const token = url.searchParams.get("token");
      if (token !== this.config.apiKey) {
        socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return;
      }
    }

    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }

    // Compute accept hash (RFC 6455 Section 4.2.2)
    const acceptHash = createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");

    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptHash}\r\n\r\n`,
    );

    const client: WsClient = { socket, alive: true };
    this.wsClients.add(client);

    let buffer = Buffer.alloc(0);

    socket.on("data", (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      this.processWsFrames(client, buffer);
      // Simplified: consume all data after processing
      buffer = Buffer.alloc(0);
    });

    socket.on("close", () => {
      this.wsClients.delete(client);
    });

    socket.on("error", () => {
      this.wsClients.delete(client);
    });
  }

  private processWsFrames(client: WsClient, data: Buffer): void {
    // Minimal WebSocket frame parsing
    if (data.length < 2) return;

    const firstByte = data[0]!;
    const secondByte = data[1]!;
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7f;
    let offset = 2;

    if (payloadLength === 126) {
      if (data.length < 4) return;
      payloadLength = (data[2]! << 8) | data[3]!;
      offset = 4;
    } else if (payloadLength === 127) {
      if (data.length < 10) return;
      payloadLength = Number(data.readBigUInt64BE(2));
      offset = 10;
    }

    if (masked) {
      offset += 4;
    }

    if (data.length < offset + payloadLength) return;

    const payload = data.slice(offset, offset + payloadLength);

    if (masked) {
      const mask = data.slice(offset - 4, offset);
      for (let i = 0; i < payload.length; i++) {
        payload[i] = payload[i]! ^ mask[i % 4]!;
      }
    }

    // Handle opcodes
    if (opcode === 0x08) {
      // Close
      this.closeWsClient(client);
    } else if (opcode === 0x09) {
      // Ping → send Pong
      this.sendWsFrame(client, 0x0a, payload);
    } else if (opcode === 0x0a) {
      // Pong
      client.alive = true;
    } else if (opcode === 0x01) {
      // Text frame
      const text = payload.toString("utf-8");
      this.handleWsMessage(client, text);
    }
  }

  private async handleWsMessage(client: WsClient, text: string): Promise<void> {
    try {
      const data = JSON.parse(text);

      if (data.type === "message" && typeof data.content === "string" && data.content.trim()) {
        const message = await this.createAndDispatch(data.content.trim(), data.senderId);
        // Acknowledge
        this.sendWsJson(client, { type: "ack", messageId: message.id });
      } else if (data.type === "ping") {
        this.sendWsJson(client, { type: "pong" });
      }
    } catch {
      // Ignore malformed messages
    }
  }

  private sendWsFrame(client: WsClient, opcode: number, payload: Buffer): void {
    if (client.socket.destroyed) return;

    const header = Buffer.alloc(2);
    header[0] = 0x80 | opcode; // FIN + opcode

    if (payload.length < 126) {
      header[1] = payload.length;
      client.socket.write(Buffer.concat([header, payload]));
    } else if (payload.length < 65536) {
      header[1] = 126;
      const ext = Buffer.alloc(2);
      ext.writeUInt16BE(payload.length, 0);
      client.socket.write(Buffer.concat([header, ext, payload]));
    } else {
      header[1] = 127;
      const ext = Buffer.alloc(8);
      ext.writeBigUInt64BE(BigInt(payload.length), 0);
      client.socket.write(Buffer.concat([header, ext, payload]));
    }
  }

  private sendWsJson(client: WsClient, data: unknown): void {
    const payload = Buffer.from(JSON.stringify(data), "utf-8");
    this.sendWsFrame(client, 0x01, payload);
  }

  private broadcastWs(data: unknown): void {
    for (const client of this.wsClients) {
      this.sendWsJson(client, data);
    }
  }

  private closeWsClient(client: WsClient): void {
    try {
      // Send close frame
      const closeFrame = Buffer.alloc(2);
      closeFrame[0] = 0x88; // FIN + Close opcode
      closeFrame[1] = 0x00;
      if (!client.socket.destroyed) {
        client.socket.write(closeFrame);
        client.socket.end();
      }
    } catch {
      // ignore
    }
    this.wsClients.delete(client);
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private async createAndDispatch(content: string, senderId?: string): Promise<ChannelMessage> {
    const message: ChannelMessage = {
      id: this.config.generateId(),
      channelType: this.channelType,
      senderId: senderId || this.config.senderId,
      content,
      attachments: [],
      timestamp: new Date().toISOString(),
    };
    this.history.push(message);
    this.receivedCount++;

    for (const cb of this.callbacks) {
      await cb(message);
    }
    return message;
  }

  private setState(state: ConnectionState): void {
    this._state = state;
    this.stateChangedAt = new Date().toISOString();
  }
}
