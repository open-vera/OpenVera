/**
 * Webhook Channel Adapter — HTTP webhook receiver with signature verification.
 * Implements the ChannelAdapter interface for receiving messages from external
 * systems (GitHub, Stripe, Slack, custom) via HTTP POST webhooks.
 *
 * Features:
 *   - HMAC-SHA256 signature verification (configurable header/algorithm)
 *   - Multiple verification strategies (GitHub, Stripe, Slack, custom)
 *   - Custom payload parser for extracting ChannelMessage from raw webhook body
 *   - Configurable path, methods, and response codes
 */

import { createHmac, timingSafeEqual } from "node:crypto";
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

/** Signature verification strategy */
export type WebhookVerifyStrategy =
  | "github"    // X-Hub-Signature-256: sha256=<hex>
  | "stripe"    // Stripe-Signature: t=<ts>,v1=<hex>
  | "slack"     // X-Slack-Signature: v0=<hex>
  | "custom";   // Custom header with configurable format

/** Signature verification configuration */
export interface WebhookSignatureConfig {
  /** Verification strategy */
  strategy: WebhookVerifyStrategy;
  /** Shared secret for HMAC */
  secret: string;
  /** Custom header name (only for "custom" strategy) */
  headerName?: string;
  /** Custom prefix before the hex signature (default: "sha256=") */
  prefix?: string;
}

/** Custom payload parser — converts raw webhook body to message fields */
export type WebhookPayloadParser = (
  body: Record<string, unknown>,
  headers: Record<string, string>,
) => { content: string; senderId?: string; attachments?: { type: "image" | "file" | "audio" | "video" | "link"; url: string; name?: string }[] } | null;

/** Configuration for the Webhook Channel Adapter */
export interface WebhookChannelConfig {
  /** Host to bind (default: "0.0.0.0") */
  host?: string;
  /** Port to listen on (default: 0 = auto-assign) */
  port?: number;
  /** Path to accept webhooks on (default: "/webhook") */
  path?: string;
  /** HTTP methods to accept (default: ["POST"]) */
  methods?: string[];
  /** Signature verification config (optional — if omitted, no verification) */
  signature?: WebhookSignatureConfig;
  /** Custom payload parser */
  parser?: WebhookPayloadParser;
  /** Default sender ID when parser doesn't provide one */
  senderId?: string;
  /** Custom message ID generator */
  generateId?: () => string;
  /** Maximum request body size in bytes (default: 1MB) */
  maxBodyBytes?: number;
  /** HTTP status code to return on success (default: 200) */
  successStatusCode?: number;
  /** Custom response body on success */
  successBody?: string;
}

const DEFAULT_CONFIG: Required<Omit<WebhookChannelConfig, "signature" | "parser" | "generateId">> & {
  signature?: WebhookSignatureConfig;
  parser?: WebhookPayloadParser;
  generateId: () => string;
} = {
  host: "0.0.0.0",
  port: 0,
  path: "/webhook",
  methods: ["POST"],
  senderId: "webhook",
  generateId: () => `wh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  maxBodyBytes: 1_048_576,
  successStatusCode: 200,
  successBody: '{"ok":true}',
};

/** Default payload parser — extracts content/senderId from generic JSON */
function defaultParser(
  body: Record<string, unknown>,
  _headers: Record<string, string>,
): { content: string; senderId?: string } | null {
  // Try common field names
  const content =
    (typeof body.content === "string" && body.content) ||
    (typeof body.text === "string" && body.text) ||
    (typeof body.message === "string" && body.message) ||
    (typeof body.body === "string" && body.body);
  if (!content) return null;
  const senderId =
    (typeof body.senderId === "string" && body.senderId) ||
    (typeof body.sender === "string" && body.sender) ||
    (typeof body.user === "string" && body.user) ||
    undefined;
  return { content, senderId };
}

/** GitHub-specific payload parser */
function githubParser(
  body: Record<string, unknown>,
  headers: Record<string, string>,
): { content: string; senderId?: string } | null {
  const event = headers["x-github-event"];
  if (event === "push") {
    const repo = body.repository as Record<string, unknown> | undefined;
    const pusher = body.pusher as Record<string, unknown> | undefined;
    const commits = body.commits as Array<Record<string, unknown>> | undefined;
    const repoName = (repo?.full_name as string) ?? "unknown";
    const author = (pusher?.name as string) ?? "unknown";
    const count = commits?.length ?? 0;
    return {
      content: `[${repoName}] ${author} pushed ${count} commit(s)`,
      senderId: author,
    };
  }
  if (event === "issues") {
    const action = body.action as string;
    const issue = body.issue as Record<string, unknown> | undefined;
    const title = (issue?.title as string) ?? "untitled";
    const user = (issue?.user as Record<string, unknown>)?.login as string | undefined;
    return {
      content: `[Issue ${action}] ${title}`,
      senderId: user,
    };
  }
  // Fallback: stringify the event
  return { content: `[GitHub:${event ?? "unknown"}] webhook received` };
}

/** Stripe-specific payload parser */
function stripeParser(
  body: Record<string, unknown>,
  _headers: Record<string, string>,
): { content: string; senderId?: string } | null {
  const type = typeof body.type === "string" ? body.type : "unknown";
  const id = typeof body.id === "string" ? body.id : "";
  return { content: `[Stripe:${type}] ${id}`, senderId: "stripe" };
}

/** Build the parsers map */
const STRATEGY_PARSERS: Record<string, WebhookPayloadParser> = {
  github: githubParser as WebhookPayloadParser,
  stripe: stripeParser as WebhookPayloadParser,
};

export class WebhookChannelAdapter implements ChannelAdapter {
  readonly name = "webhook";
  readonly channelType = "webhook" as const;

  private _state: ConnectionState = "disconnected";
  private config: typeof DEFAULT_CONFIG;
  private server: Server | null = null;
  private callbacks: MessageCallback[] = [];
  private history: ChannelMessage[] = [];
  private sentCount = 0;
  private receivedCount = 0;
  private stateChangedAt: string = new Date().toISOString();
  private actualPort = 0;

  constructor(config?: WebhookChannelConfig) {
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
      message: `Webhook channel on port ${this.actualPort}, path ${this.config.path}`,
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

    // Webhooks are receive-only — we still record outbound messages in history
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
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", this.config.methods.join(", "));
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Hub-Signature-256, Stripe-Signature, X-Slack-Signature");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Check method and path
    const url = new URL(req.url ?? "/", `http://localhost:${this.actualPort}`);
    const allowedMethods = this.config.methods.map((m) => m.toUpperCase());

    if (!allowedMethods.includes(req.method ?? "") || url.pathname !== this.config.path) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    try {
      // Read body
      const { raw, body } = await this.readBody(req);

      if (!body) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Empty request body" }));
        return;
      }

      // Signature verification
      if (this.config.signature) {
        const headers = this.normalizeHeaders(req);
        const valid = this.verifySignature(raw, headers, this.config.signature);
        if (!valid) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid signature" }));
          return;
        }
      }

      // Parse payload
      const headers = this.normalizeHeaders(req);
      const parsed = this.parsePayload(body, headers);
      if (!parsed) {
        res.writeHead(422, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unable to parse webhook payload" }));
        return;
      }

      // Create and dispatch message
      const message = await this.createAndDispatch(parsed.content, parsed.senderId, parsed.attachments);

      res.writeHead(this.config.successStatusCode, { "Content-Type": "application/json" });
      res.end(this.config.successBody);
      return;
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
  }

  private readBody(req: IncomingMessage): Promise<{ raw: Buffer; body: Record<string, unknown> | null }> {
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
          resolve({ raw, body: null });
          return;
        }
        try {
          const body = JSON.parse(raw.toString("utf-8"));
          resolve({ raw, body });
        } catch {
          reject(new Error("Invalid JSON"));
        }
      });

      req.on("error", reject);
    });
  }

  private normalizeHeaders(req: IncomingMessage): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") {
        result[key.toLowerCase()] = value;
      } else if (Array.isArray(value)) {
        result[key.toLowerCase()] = value.join(", ");
      }
    }
    return result;
  }

  // ── Signature Verification ─────────────────────────────────────────────────

  private verifySignature(
    rawBody: Buffer,
    headers: Record<string, string>,
    config: WebhookSignatureConfig,
  ): boolean {
    switch (config.strategy) {
      case "github":
        return this.verifyGithub(rawBody, headers, config.secret);
      case "stripe":
        return this.verifyStripe(rawBody, headers, config.secret);
      case "slack":
        return this.verifySlack(rawBody, headers, config.secret);
      case "custom":
        return this.verifyCustom(rawBody, headers, config);
      default:
        return false;
    }
  }

  /** GitHub: X-Hub-Signature-256: sha256=<hex> */
  private verifyGithub(rawBody: Buffer, headers: Record<string, string>, secret: string): boolean {
    const signature = headers["x-hub-signature-256"];
    if (!signature) return false;

    const expected = "sha256=" + this.hmacHex(rawBody, secret);
    return this.timingSafeCompare(signature, expected);
  }

  /** Stripe: Stripe-Signature: t=<timestamp>,v1=<hex> */
  private verifyStripe(rawBody: Buffer, headers: Record<string, string>, secret: string): boolean {
    const header = headers["stripe-signature"];
    if (!header) return false;

    const parts = Object.fromEntries(
      header.split(",").map((p) => {
        const [k, ...v] = p.split("=");
        return [k, v.join("=")];
      }),
    );

    const timestamp = parts["t"];
    const signature = parts["v1"];
    if (!timestamp || !signature) return false;

    const payload = `${timestamp}.${rawBody.toString("utf-8")}`;
    const expected = this.hmacHex(Buffer.from(payload, "utf-8"), secret);
    return this.timingSafeCompare(signature, expected);
  }

  /** Slack: X-Slack-Signature: v0=<hex> */
  private verifySlack(rawBody: Buffer, headers: Record<string, string>, secret: string): boolean {
    const signature = headers["x-slack-signature"];
    if (!signature) return false;

    const expected = "v0=" + this.hmacHex(rawBody, secret);
    return this.timingSafeCompare(signature, expected);
  }

  /** Custom: configurable header with optional prefix */
  private verifyCustom(
    rawBody: Buffer,
    headers: Record<string, string>,
    config: WebhookSignatureConfig,
  ): boolean {
    const headerName = config.headerName ?? "x-signature-256";
    const prefix = config.prefix ?? "sha256=";
    const signature = headers[headerName.toLowerCase()];
    if (!signature) return false;

    const hex = this.hmacHex(rawBody, config.secret);
    const expected = prefix + hex;
    return this.timingSafeCompare(signature, expected);
  }

  private hmacHex(data: Buffer, secret: string): string {
    return createHmac("sha256", secret).update(data).digest("hex");
  }

  private timingSafeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    const bufA = Buffer.from(a, "utf-8");
    const bufB = Buffer.from(b, "utf-8");
    return timingSafeEqual(bufA, bufB);
  }

  // ── Payload Parsing ────────────────────────────────────────────────────────

  private parsePayload(
    body: Record<string, unknown>,
    headers: Record<string, string>,
  ): { content: string; senderId?: string; attachments?: { type: "image" | "file" | "audio" | "video" | "link"; url: string; name?: string }[] } | null {
    // Custom parser takes priority
    if (this.config.parser) {
      return this.config.parser(body, headers);
    }

    // Strategy-specific parsers
    if (this.config.signature?.strategy) {
      const strategyParser = STRATEGY_PARSERS[this.config.signature.strategy];
      if (strategyParser) {
        return strategyParser(body, headers);
      }
    }

    // Default generic parser
    return defaultParser(body, headers);
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private async createAndDispatch(
    content: string,
    senderId?: string,
    attachments?: { type: "image" | "file" | "audio" | "video" | "link"; url: string; name?: string }[],
  ): Promise<ChannelMessage> {
    const message: ChannelMessage = {
      id: this.config.generateId(),
      channelType: this.channelType,
      senderId: senderId || this.config.senderId,
      content,
      attachments: attachments ?? [],
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
