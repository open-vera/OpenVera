// Tool Runtime 入口 — 构建完整注册表

import { ToolRegistry } from "./registry.js";
import { SecurityPlugin } from "./security.js";
import type { SecurityConfig } from "./security.js";
import { AnalyticsPlugin } from "./analytics.js";
import type { SessionStore } from "../session/index.js";

import { readFileTool } from "./read-file.js";
import { writeFileTool } from "./write-file.js";
import { editFileTool } from "./edit-file.js";
import { listDirTool } from "./list-dir.js";
import { globTool } from "./glob.js";
import { bashTool } from "./bash.js";
import { grepTool } from "./grep.js";

export { ToolRegistry } from "./registry.js";
export { SecurityPlugin } from "./security.js";
export type { SecurityConfig } from "./security.js";
export { AnalyticsPlugin } from "./analytics.js";
export type { ToolDef, ToolResult, ToolContext, ToolLifecycleHook, RenderHint, ToolErrorCode } from "./types.js";
export { errorResult } from "./types.js";

export interface CreateToolRegistryOptions {
  cwd: string;
  security?: SecurityConfig;
  sessionStore?: SessionStore;
}

export interface ToolRegistryBundle {
  registry: ToolRegistry;
  security: SecurityPlugin;
}

export function createToolRegistry(opts: CreateToolRegistryOptions): ToolRegistryBundle {
  const registry = new ToolRegistry();

  // Register built-in tools
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(editFileTool);
  registry.register(listDirTool);
  registry.register(globTool);
  registry.register(bashTool);
  registry.register(grepTool);

  // Register SecurityPlugin (runs first — short-circuits on denial)
  const security = new SecurityPlugin({ workdir: opts.cwd, ...opts.security });
  registry.use(security);

  // Register AnalyticsPlugin (session JSONL writing)
  if (opts.sessionStore) {
    registry.use(new AnalyticsPlugin(opts.sessionStore));
  }

  return { registry, security };
}
