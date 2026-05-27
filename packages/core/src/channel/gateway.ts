/**
 * Channel Gateway — manages multiple channel adapters,
 * routes messages, binds sessions, emits lifecycle events.
 */

import type {
  ChannelAdapter,
  ChannelMessage,
  ConnectionState,
  GatewayConfig,
  GatewayEvent,
  GatewayEventCallback,
  MessageCallback,
  SendMessageOptions,
} from "./types.js";
import { ChannelNotFoundError } from "./types.js";

export interface SessionBinding {
  sessionId: string;
  channelName: string;
  boundAt: string;
  metadata: Record<string, unknown>;
}

export type MessageHandler = (message: ChannelMessage, channelName: string) => void | Promise<void>;

const DEFAULT_CONFIG: Required<GatewayConfig> = {
  maxConnections: 10,
  defaultTimeoutMs: 30_000,
  autoReconnect: false,
  reconnectIntervalMs: 5_000,
  maxReconnectAttempts: 3,
};

export class ChannelGateway {
  readonly config: Required<GatewayConfig>;

  private adapters = new Map<string, ChannelAdapter>();
  private messageHandlers: MessageHandler[] = [];
  private eventCallbacks: GatewayEventCallback[] = [];
  private sessions = new Map<string, SessionBinding>();
  private unsubscribers = new Map<string, () => void>();

  constructor(config?: GatewayConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Adapter Management ──────────────────────────────────────────────────

  addAdapter(name: string, adapter: ChannelAdapter): void {
    if (this.adapters.has(name)) {
      throw new Error(`Channel adapter '${name}' already registered`);
    }
    if (this.adapters.size >= this.config.maxConnections) {
      throw new Error(`Maximum connections (${this.config.maxConnections}) reached`);
    }
    this.adapters.set(name, adapter);
    // Wire up message routing from this adapter
    const unsub = adapter.onMessage((msg) => this.dispatchMessage(msg, name));
    this.unsubscribers.set(name, unsub);
  }

  removeAdapter(name: string): boolean {
    const existed = this.adapters.delete(name);
    if (existed) {
      // Unsubscribe message handler
      const unsub = this.unsubscribers.get(name);
      if (unsub) {
        unsub();
        this.unsubscribers.delete(name);
      }
      // Clean up sessions bound to this channel
      for (const [sessionId, binding] of this.sessions) {
        if (binding.channelName === name) {
          this.sessions.delete(sessionId);
        }
      }
    }
    return existed;
  }

  getAdapter(name: string): ChannelAdapter | undefined {
    return this.adapters.get(name);
  }

  listAdapters(): Array<{ name: string; state: ConnectionState }> {
    return Array.from(this.adapters.entries()).map(([name, adapter]) => ({
      name,
      state: adapter.state,
    }));
  }

  // ── Connection Lifecycle ────────────────────────────────────────────────

  async connect(name: string): Promise<void> {
    const adapter = this.getAdapterOrThrow(name);
    await adapter.connect();
    this.emitEvent({ type: "channel_connected", channelName: name });
  }

  async disconnect(name: string): Promise<void> {
    const adapter = this.getAdapterOrThrow(name);
    await adapter.disconnect();
    this.emitEvent({ type: "channel_disconnected", channelName: name });
  }

  async connectAll(): Promise<PromiseSettledResult<void>[]> {
    const entries = Array.from(this.adapters.entries());
    const results = await Promise.allSettled(
      entries.map(async ([name, adapter]) => {
        await adapter.connect();
        this.emitEvent({ type: "channel_connected", channelName: name });
      }),
    );

    // Handle auto-reconnect for failed connections
    if (this.config.autoReconnect) {
      results.forEach((result, i) => {
        if (result.status === "rejected") {
          this.scheduleReconnect(entries[i][0], entries[i][1]);
        }
      });
    }

    return results;
  }

  async disconnectAll(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.adapters.entries()).map(async ([name, adapter]) => {
        await adapter.disconnect();
        this.emitEvent({ type: "channel_disconnected", channelName: name });
      }),
    );
  }

  // ── Messaging ───────────────────────────────────────────────────────────

  async sendMessage(channelName: string, options: SendMessageOptions): Promise<ChannelMessage> {
    const adapter = this.getAdapterOrThrow(channelName);
    const message = await adapter.sendMessage(options);
    this.emitEvent({ type: "message_sent", channelName, message });
    return message;
  }

  async getHistory(channelName: string, ...args: Parameters<ChannelAdapter["getHistory"]>): Promise<ChannelMessage[]> {
    const adapter = this.getAdapterOrThrow(channelName);
    return adapter.getHistory(...args);
  }

  // ── Event Handlers ──────────────────────────────────────────────────────

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.push(handler);
    return () => {
      const idx = this.messageHandlers.indexOf(handler);
      if (idx >= 0) this.messageHandlers.splice(idx, 1);
    };
  }

  onEvent(callback: GatewayEventCallback): () => void {
    this.eventCallbacks.push(callback);
    return () => {
      const idx = this.eventCallbacks.indexOf(callback);
      if (idx >= 0) this.eventCallbacks.splice(idx, 1);
    };
  }

  // ── Session Binding ─────────────────────────────────────────────────────

  bindSession(channelName: string, sessionId: string, metadata: Record<string, unknown> = {}): SessionBinding {
    if (!this.adapters.has(channelName)) {
      throw new ChannelNotFoundError(channelName);
    }
    const binding: SessionBinding = {
      sessionId,
      channelName,
      boundAt: new Date().toISOString(),
      metadata,
    };
    this.sessions.set(sessionId, binding);
    return binding;
  }

  unbindSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  getSession(sessionId: string): SessionBinding | undefined {
    return this.sessions.get(sessionId);
  }

  getSessionsForChannel(channelName: string): SessionBinding[] {
    return Array.from(this.sessions.values()).filter((s) => s.channelName === channelName);
  }

  // ── Message Dispatch ─────────────────────────────────────────────────────

  async dispatchMessage(message: ChannelMessage, channelName: string): Promise<void> {
    this.emitEvent({ type: "message_received", channelName, message });
    await Promise.all(
      this.messageHandlers.map((handler) => handler(message, channelName)),
    );
  }

  private emitEvent(event: GatewayEvent): void {
    for (const callback of this.eventCallbacks) {
      callback(event);
    }
  }

  private getAdapterOrThrow(name: string): ChannelAdapter {
    const adapter = this.adapters.get(name);
    if (!adapter) {
      throw new ChannelNotFoundError(name);
    }
    return adapter;
  }

  private scheduleReconnect(name: string, adapter: ChannelAdapter): void {
    let attempt = 0;
    const tryReconnect = async (): Promise<void> => {
      attempt++;
      if (attempt > this.config.maxReconnectAttempts) return;
      this.emitEvent({ type: "reconnecting", channelName: name, attempt });
      try {
        await adapter.connect();
        this.emitEvent({ type: "channel_connected", channelName: name });
      } catch {
        setTimeout(tryReconnect, this.config.reconnectIntervalMs);
      }
    };
    setTimeout(tryReconnect, this.config.reconnectIntervalMs);
  }
}
