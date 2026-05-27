/**
 * Message Bus — Cross-agent communication infrastructure.
 *
 * Provides pub/sub messaging between agents, enabling coordination,
 * task delegation, and result aggregation in multi-agent systems.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type MessageType =
  | "task_request"
  | "task_result"
  | "status_update"
  | "resource_request"
  | "resource_response"
  | "broadcast"
  | "direct";

export interface Message {
  id: string;
  type: MessageType;
  from: string;
  to: string | "*"; // "*" for broadcast
  payload: unknown;
  timestamp: string;
  replyTo?: string;
  priority: "low" | "normal" | "high" | "urgent";
}

export type MessageHandler = (message: Message) => void | Promise<void>;

// ── Message Bus ──────────────────────────────────────────────────────────────

export class MessageBus {
  private subscribers = new Map<string, Set<MessageHandler>>();
  private globalSubscribers = new Set<MessageHandler>();
  private messageHistory: Message[] = [];
  private maxHistory: number;

  constructor(options?: { maxHistory?: number }) {
    this.maxHistory = options?.maxHistory ?? 1000;
  }

  /**
   * Publish a message to the bus.
   */
  async publish(message: Omit<Message, "id" | "timestamp">): Promise<Message> {
    const fullMessage: Message = {
      ...message,
      id: this.generateId(),
      timestamp: new Date().toISOString(),
    };

    this.messageHistory.push(fullMessage);
    if (this.messageHistory.length > this.maxHistory) {
      this.messageHistory.shift();
    }

    // Deliver to specific recipient
    if (fullMessage.to !== "*") {
      const handlers = this.subscribers.get(fullMessage.to);
      if (handlers) {
        for (const handler of handlers) {
          await handler(fullMessage);
        }
      }
    }

    // Deliver to global subscribers (broadcast)
    for (const handler of this.globalSubscribers) {
      await handler(fullMessage);
    }

    // If broadcast, deliver to all subscribers
    if (fullMessage.to === "*") {
      for (const [agentId, handlers] of this.subscribers) {
        if (agentId !== fullMessage.from) {
          for (const handler of handlers) {
            await handler(fullMessage);
          }
        }
      }
    }

    return fullMessage;
  }

  /**
   * Subscribe to messages for a specific agent.
   */
  subscribe(agentId: string, handler: MessageHandler): () => void {
    if (!this.subscribers.has(agentId)) {
      this.subscribers.set(agentId, new Set());
    }
    this.subscribers.get(agentId)!.add(handler);

    return () => {
      this.subscribers.get(agentId)?.delete(handler);
    };
  }

  /**
   * Subscribe to all messages (for monitoring/logging).
   */
  subscribeAll(handler: MessageHandler): () => void {
    this.globalSubscribers.add(handler);
    return () => {
      this.globalSubscribers.delete(handler);
    };
  }

  /**
   * Request-reply pattern: send a request and wait for a reply.
   */
  async request(
    from: string,
    to: string,
    payload: unknown,
    timeoutMs = 10000,
  ): Promise<Message> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const unsubscribe = this.subscribe(from, (msg) => {
        if (msg.replyTo === requestId) {
          clearTimeout(timer);
          unsubscribe();
          resolve(msg);
        }
      });

      let requestId: string;
      this.publish({
        type: "task_request",
        from,
        to,
        payload,
        priority: "normal",
      }).then((msg) => {
        requestId = msg.id;
      });
    });
  }

  /**
   * Get message history.
   */
  getHistory(filter?: { from?: string; to?: string; type?: MessageType }): Message[] {
    let results = [...this.messageHistory];

    if (filter?.from) {
      results = results.filter((m) => m.from === filter.from);
    }
    if (filter?.to) {
      results = results.filter((m) => m.to === filter.to || m.to === "*");
    }
    if (filter?.type) {
      results = results.filter((m) => m.type === filter.type);
    }

    return results;
  }

  /**
   * Get subscriber count for an agent.
   */
  getSubscriberCount(agentId: string): number {
    return this.subscribers.get(agentId)?.size ?? 0;
  }

  /**
   * Get all registered agent IDs.
   */
  getRegisteredAgents(): string[] {
    return [...this.subscribers.keys()];
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private generateId(): string {
    return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
