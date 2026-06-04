// ToolRegistry — 注册、hook、middleware、stats、执行

import type { Tool } from "../types/tool.js";
import type {
  ToolDef,
  ToolResult,
  ToolContext,
  ToolLifecycleHook,
  ToolMiddleware,
  ToolGroup,
} from "./types.js";
import { toolDefToSchema, errorResult } from "./types.js";
import { executeWithTimeout } from "./executor.js";
import { ToolStatsCollector } from "./tool-stats.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("tool:registry");

export class ToolRegistry {
  private tools = new Map<string, ToolDef>();
  private hooks: ToolLifecycleHook[] = [];
  private middlewares: ToolMiddleware[] = [];
  private groups = new Map<string, ToolGroup>();
  private readonly statsCollector: ToolStatsCollector;
  /** Idempotent result cache: callKey → cached result. Session-scoped. */
  private idempotentCache = new Map<string, ToolResult>();

  constructor(opts?: { statsMaxRecords?: number }) {
    this.statsCollector = new ToolStatsCollector(opts?.statsMaxRecords ?? 1_000);
  }

  // ── Registration ─────────────────────────────────────────────────────

  register<TArgs extends object>(tool: ToolDef<TArgs>): void {
    this.tools.set(tool.name, tool as ToolDef);
  }

  registerGroup<TArgs extends object>(group: ToolGroup, tools: ToolDef<TArgs>[]): void {
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

    // T3: Dry-run — return simulated result without executing
    if (ctx.dryRun) {
      return {
        ok: true,
        content: `[DRY RUN] Would execute: ${name}(${JSON.stringify(args)})`,
        dryRun: true,
      };
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
      } catch (err) {
        // Isolate: a failing before hook must not block other middlewares
        // but surface the error so misconfiguration isn't silent
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[ToolRegistry] Middleware "${mw.name}" before hook failed: ${msg}`);
        throw err;
      }
    }

    // T1: Idempotent cache — check after middleware (args may have been mutated)
    const isIdempotent = toolDef.options?.idempotent === true;
    if (isIdempotent && !skipped) {
      const callKey = `${name}:${JSON.stringify(currentArgs)}`;
      const cached = this.idempotentCache.get(callKey);
      if (cached) {
        return cached;
      }
    }

    // Execute with timeout + stats
    const startMs = Date.now();
    let result: ToolResult;

    if (skipped && skipResult) {
      result = skipResult;
    } else {
      // T2: Retry logic for retryable errors
      const maxRetries = 3;
      let lastResult: ToolResult | undefined;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          lastResult = await executeWithTimeout(
            () => toolDef.execute(currentArgs as never, ctx),
            toolDef.options?.timeoutMs ?? 30_000
          );
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));

          // Middleware — onError phase (only on final attempt)
          if (attempt >= maxRetries) {
            for (const mw of this.middlewares) {
              if (!mw.onError) continue;
              const recovered = await mw.onError(name, currentArgs, error, ctx);
              if (recovered) {
                lastResult = recovered;
                error.message = ""; // Mark as handled
                break;
              }
            }
            if (!lastResult!) {
              lastResult = errorResult("UNKNOWN", error.message, true);
            }
          } else {
            // Retryable exception — wait with exponential backoff
            lastResult = errorResult("UNKNOWN", error.message, true);
            lastResult.retryCount = attempt + 1;
            await sleep(100 * Math.pow(2, attempt));
            continue;
          }
        }

        // Check if result is retryable
        if (
          lastResult &&
          !lastResult.ok &&
          lastResult.error?.retryable &&
          attempt < maxRetries
        ) {
          lastResult.retryCount = attempt + 1;
          await sleep(100 * Math.pow(2, attempt));
          continue;
        }

        // Success or non-retryable — break
        if (lastResult) {
          lastResult.retryCount = attempt;
        }
        break;
      }

      result = lastResult!;
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

    // T1: Cache result for idempotent tools
    if (isIdempotent && !skipped && result.ok) {
      const callKey = `${name}:${JSON.stringify(currentArgs)}`;
      this.idempotentCache.set(callKey, result);
    }

    // Record stats (fire-and-forget)
    this.statsCollector.record(name, currentArgs, result, durationMs, ctx.sessionId);

    log.debug("tool executed", { tool: name, ok: result.ok, duration_ms: durationMs });

    return result;
  }

  /** Clear the idempotent result cache (e.g., on session reset). */
  clearIdempotentCache(): void {
    this.idempotentCache.clear();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
