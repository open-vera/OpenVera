// AnalyticsPlugin — session JSONL 写入（从 App.tsx 移入 hook）

import type { ToolAuditSink } from "./tool-host.js";
import type { ToolLifecycleHook, ToolResult, ToolContext } from "./types.js";
import type { SessionStore } from "../session/index.js";

export class AnalyticsPlugin implements ToolLifecycleHook, ToolAuditSink {
  readonly name = "builtin-analytics-sink";
  private store: SessionStore;
  // Map toolCallId → uuid so onAfterToolCall can write the result entry
  private pendingCallUuids = new Map<string, string>();

  constructor(store: SessionStore) {
    this.store = store;
  }

  async onBeforeToolCall(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolResult | null> {
    const toolCallId = `${name}-${Date.now()}`;
    const uuid = this.store.writeToolCall({
      parentUuid: ctx.sessionId, // placeholder; refined when wired through agent loop
      toolName: name,
      toolCallId,
      arguments: args,
    });
    this.pendingCallUuids.set(`${name}:${ctx.sessionId}`, uuid);
    return null; // never intercept
  }

  async onAfterToolCall(
    name: string,
    _args: Record<string, unknown>,
    result: ToolResult,
    ctx: ToolContext
  ): Promise<void> {
    const key = `${name}:${ctx.sessionId}`;
    const parentUuid = this.pendingCallUuids.get(key) ?? ctx.sessionId;
    this.pendingCallUuids.delete(key);
    this.store.writeToolResult({
      parentUuid,
      toolCallId: name,
      content: result.content,
    });
  }

  async onToolResult(event: {
    name: string;
    args: Record<string, unknown>;
    ctx: ToolContext;
    result: ToolResult;
  }): Promise<void> {
    await this.onBeforeToolCall(event.name, event.args, event.ctx);
    await this.onAfterToolCall(event.name, event.args, event.result, event.ctx);
  }
}
