/**
 * CLI Channel Adapter — command-line interaction with interactive, pipe,
 * and non-interactive modes. Implements the ChannelAdapter interface.
 */

import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
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

/** Configuration for the CLI Channel Adapter */
export interface CliChannelConfig {
  /** Mode of operation: interactive (REPL), pipe (read all stdin), non-interactive (single-shot) */
  mode?: "interactive" | "pipe" | "non-interactive";
  /** Custom input stream (default: process.stdin) */
  input?: Readable;
  /** Custom output stream (default: process.stdout) */
  output?: Writable;
  /** Prompt string for interactive mode */
  prompt?: string;
  /** Sender ID for messages from stdin */
  senderId?: string;
  /** Custom message ID generator */
  generateId?: () => string;
}

const DEFAULT_CONFIG: Required<Omit<CliChannelConfig, "input" | "output" | "generateId">> & {
  input?: Readable;
  output?: Writable;
  generateId: () => string;
} = {
  mode: "interactive",
  prompt: "> ",
  senderId: "cli-user",
  generateId: () => `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
};

export class CliChannelAdapter implements ChannelAdapter {
  readonly name = "cli";
  readonly channelType = "cli" as const;

  private _state: ConnectionState = "disconnected";
  private config: typeof DEFAULT_CONFIG;
  private rl: ReadlineInterface | null = null;
  private callbacks: MessageCallback[] = [];
  private history: ChannelMessage[] = [];
  private sentCount = 0;
  private receivedCount = 0;
  private stateChangedAt: string = new Date().toISOString();

  constructor(config?: CliChannelConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  get state(): ConnectionState {
    return this._state;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.setState("connecting");

    const mode = this.config.mode;
    if (mode === "interactive") {
      this.startInteractive();
    } else if (mode === "pipe") {
      await this.readPipe();
    }
    // non-interactive: just mark connected, wait for explicit processInput()

    this.setState("connected");
  }

  async disconnect(): Promise<void> {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    this.setState("disconnected");
  }

  getStatus(): ChannelStatus {
    return {
      state: this._state,
      message: `CLI channel in ${this.config.mode} mode`,
      changedAt: this.stateChangedAt,
      sentCount: this.sentCount,
      receivedCount: this.receivedCount,
    };
  }

  // ── Messaging ──────────────────────────────────────────────────────────────

  async sendMessage(options: SendMessageOptions): Promise<ChannelMessage> {
    if (this._state === "disconnected") {
      throw new ChannelNotConnectedError(this.name);
    }

    const output = this.config.output ?? process.stdout;
    try {
      output.write(options.content + "\n");
    } catch (err) {
      throw new ChannelSendError(this.name, String(err));
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
    if (options?.senderId) {
      result = result.filter((m) => m.senderId === options.senderId);
    }
    if (options?.limit) {
      result = result.slice(0, options.limit);
    }
    return result;
  }

  // ── CLI-specific public methods ────────────────────────────────────────────

  /**
   * Process a single input string (for non-interactive / programmatic use).
   * Dispatches the input as an incoming message to all registered callbacks.
   */
  async processInput(input: string): Promise<ChannelMessage> {
    if (this._state !== "connected") {
      throw new ChannelNotConnectedError(this.name);
    }
    return this.createAndDispatch(input.trim());
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private startInteractive(): void {
    const input = this.config.input ?? process.stdin;
    const output = this.config.output ?? process.stdout;

    this.rl = createInterface({ input, output, terminal: false });

    this.rl.on("line", (line: string) => {
      const trimmed = line.trim();
      if (trimmed) {
        this.createAndDispatch(trimmed);
      }
      this.rl?.prompt();
    });

    this.rl.on("close", () => {
      this.setState("disconnected");
    });

    this.rl.prompt();
  }

  private async readPipe(): Promise<void> {
    const input = this.config.input ?? process.stdin;
    const chunks: Buffer[] = [];

    return new Promise<void>((resolve) => {
      input.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.from(chunk));
      });
      input.on("end", () => {
        const content = Buffer.concat(chunks).toString("utf-8").trim();
        if (content) {
          this.createAndDispatch(content);
        }
        resolve();
      });
      // If stdin is already ended (e.g., in tests), resolve immediately
      if ((input as Readable).readableEnded) {
        const content = Buffer.concat(chunks).toString("utf-8").trim();
        if (content) {
          this.createAndDispatch(content);
        }
        resolve();
      }
    });
  }

  private async createAndDispatch(content: string): Promise<ChannelMessage> {
    const message: ChannelMessage = {
      id: this.config.generateId(),
      channelType: this.channelType,
      senderId: this.config.senderId,
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
