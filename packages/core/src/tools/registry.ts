// ToolRegistry — 注册、hook、执行

import type { Tool } from "../types/tool.js";
import type { ToolDef, ToolResult, ToolContext, ToolLifecycleHook } from "./types.js";
import { toolDefToSchema, errorResult } from "./types.js";
import { executeWithTimeout } from "./executor.js";

export class ToolRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tools = new Map<string, ToolDef<any>>();
  private hooks: ToolLifecycleHook[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(tool: ToolDef<any>): void {
    this.tools.set(tool.name, tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  use(hook: ToolLifecycleHook): void {
    this.hooks.push(hook);
  }

  /** Returns Tool[] schema list for the LLM. */
  getSchemas(): Tool[] {
    return [...this.tools.values()].map(toolDefToSchema);
  }

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

    // onBeforeToolCall — first non-null return short-circuits
    for (const hook of this.hooks) {
      if (!hook.onBeforeToolCall) continue;
      const intercepted = await hook.onBeforeToolCall(name, args, ctx);
      if (intercepted !== null) return intercepted;
    }

    // Execute with timeout
    let result: ToolResult;
    try {
      result = await executeWithTimeout(
        () => toolDef.execute(args as never, ctx),
        toolDef.options?.timeoutMs ?? 30_000
      );
    } catch (err) {
      result = errorResult(
        "UNKNOWN",
        err instanceof Error ? err.message : String(err),
        true
      );
    }

    // onAfterToolCall
    for (const hook of this.hooks) {
      if (!hook.onAfterToolCall) continue;
      await hook.onAfterToolCall(name, args, result, ctx);
    }

    return result;
  }
}
