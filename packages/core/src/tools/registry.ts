// ToolRegistry — 注册、hook、middleware、stats、执行

import type { Tool } from "../types/tool.js";
import type {
  ToolDef,
  ToolResult,
  ToolContext,
  ToolLifecycleHook,
  ToolMiddleware,
  ToolGroup,
  ToolVersion,
} from "./types.js";
import { toolDefToSchema, errorResult } from "./types.js";
import { executeWithTimeout } from "./executor.js";
import { ToolStatsCollector } from "./tool-stats.js";

export class ToolRegistry {
  private tools = new Map<string, ToolDef>();
  private hooks: ToolLifecycleHook[] = [];
  private middlewares: ToolMiddleware[] = [];
  private groups = new Map<string, ToolGroup>();
  private readonly statsCollector: ToolStatsCollector;

  constructor(opts?: { statsMaxRecords?: number }) {
    this.statsCollector = new ToolStatsCollector(opts?.statsMaxRecords ?? 1_000);
  }

  // ── Registration ─────────────────────────────────────────────────────

  register(tool: ToolDef): void {
    this.tools.set(tool.name, tool);
  }

  registerGroup(group: ToolGroup, tools: ToolDef[]): void {
    this.groups.set(group.name, group);
    for (const tool of tools) {
      tool.group = tool.group ?? group.name;
      tool.options = { ...group.defaults, ...tool.options };
      this.register(tool);
    }
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  /** Get all tools in a named group. */
  getGroup(name: string): { group: ToolGroup; tools: ToolDef[] } | undefined {
    const group = this.groups.get(name);
    if (!group) return undefined;
    const tools = [...this.tools.values()].filter((t) => t.group === name);
    return { group, tools };
  }

  list(): ToolDef[] {
    return [...this.tools.values()];
  }

  // ── Hooks ────────────────────────────────────────────────────────────

  use(hook: ToolLifecycleHook): void {
    this.hooks.push(hook);
  }

  // ── Middleware ────────────────────────────────────────────────────────

  addMiddleware(middleware: ToolMiddleware): void {
    this.middlewares.push(middleware);
  }

  removeMiddleware(name: string): boolean {
    const idx = this.middlewares.findIndex((m) => m.name === name);
    if (idx >= 0) {
      this.middlewares.splice(idx, 1);
      return true;
    }
    return false;
  }

  // ── Schemas ──────────────────────────────────────────────────────────

  /** Returns Tool[] schema list for the LLM. */
  getSchemas(): Tool[] {
    return [...this.tools.values()].map(toolDefToSchema);
  }

  /** Returns schemas filtered by group. */
  getSchemasByGroup(groupName: string): Tool[] {
    return [...this.tools.values()]
      .filter((t) => t.group === groupName)
      .map(toolDefToSchema);
  }

  /** Check if a tool is deprecated. Returns warning string or null. */
  getDeprecationWarning(name: string): string | null {
    const tool = this.tools.get(name);
    if (!tool?.version?.deprecated) return null;
    const reason = tool.version.deprecatedReason ?? "This tool is deprecated.";
    const replacement = tool.version.replacedBy
      ? ` Use "${tool.version.replacedBy}" instead.`
      : "";
    return `${reason}${replacement}`;
  }

  // ── Stats ────────────────────────────────────────────────────────────

  get stats(): ToolStatsCollector {
    return this.statsCollector;
  }

  // ── Execution ────────────────────────────────────────────────────────

  /** Called by agent loop's onToolCall. */
  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolResult> {
    const toolDef = this.tools.get(name);
    if (!toolDef) {
      return errorResult("UNKNOWN", `Tool not found: ${name}`);
    }

    // Deprecation warning (non-blocking)
    const depWarning = this.getDeprecationWarning(name);
    if (depWarning) {
      console.warn(`[ToolRegistry] Tool "${name}" is deprecated: ${depWarning}`);
    }

    // Lifecycle hooks — onBeforeToolCall
    for (const hook of this.hooks) {
      if (!hook.onBeforeToolCall) continue;
      const intercepted = await hook.onBeforeToolCall(name, args, ctx);
      if (intercepted !== null) return intercepted;
    }

    // Middleware — before phase
    let currentArgs = { ...args };
    let skipped = false;
    let skipResult: ToolResult | undefined;
    for (const mw of this.middlewares) {
      if (!mw.before) continue;
      try {
        const result = await mw.before(name, currentArgs, ctx);
        if (result) {
          if (result.skip && result.result) {
            skipped = true;
            skipResult = result.result;
            break;
          }
          currentArgs = result.args;
        }
      } catch {
        // Isolate: a failing before hook must not block other middlewares
      }
    }

    // Execute with timeout + stats
    const startMs = Date.now();
    let result: ToolResult;

    if (skipped && skipResult) {
      result = skipResult;
    } else {
      try {
        result = await executeWithTimeout(
          () => toolDef.execute(currentArgs as never, ctx),
          toolDef.options?.timeoutMs ?? 30_000
        );
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));

        // Middleware — onError phase
        for (const mw of this.middlewares) {
          if (!mw.onError) continue;
          const recovered = await mw.onError(name, currentArgs, error, ctx);
          if (recovered) {
            result = recovered;
            error.message = ""; // Mark as handled
            break;
          }
        }
        if (!result!) {
          result = errorResult("UNKNOWN", error.message, true);
        }
      }
    }

    const durationMs = Date.now() - startMs;

    // Middleware — after phase
    for (const mw of this.middlewares) {
      if (!mw.after) continue;
      result = await mw.after(name, currentArgs, result, ctx);
    }

    // Lifecycle hooks — onAfterToolCall
    for (const hook of this.hooks) {
      if (!hook.onAfterToolCall) continue;
      await hook.onAfterToolCall(name, currentArgs, result, ctx);
    }

    // Record stats (fire-and-forget)
    this.statsCollector.record(name, currentArgs, result, durationMs, ctx.sessionId);

    return result;
  }
}
