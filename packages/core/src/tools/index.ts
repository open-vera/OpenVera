// Tool Runtime 入口 — 构建完整注册表

import { execFileSync } from "node:child_process";
import { ToolRegistry } from "./registry.js";
import { SecurityPlugin } from "./security.js";
import type { SecurityConfig } from "./security.js";
import { AnalyticsPlugin } from "./analytics.js";
import type { SessionStore } from "../session/index.js";
import { loadPermissionRules } from "./permission-rules.js";

import { readFileTool } from "./read-file.js";
import { writeFileTool } from "./write-file.js";
import { editFileTool } from "./edit-file.js";
import { listDirTool } from "./list-dir.js";
import { globTool } from "./glob.js";
import { bashTool } from "./bash.js";
import { grepTool } from "./grep.js";
import { createMemoryWriteTool } from "./memory-write.js";
import { createMemorySearchTool } from "./memory-search.js";
import type { MemoryStore } from "../memory/store.js";
import { createDataSaveTool, createDataLoadTool, createDataListTool, createDataDeleteTool } from "../storage/user-data.js";
import type { UserDataStore } from "../storage/user-data.js";

export { ToolRegistry } from "./registry.js";
export { SecurityPlugin } from "./security.js";
export type { SecurityConfig } from "./security.js";
export { AnalyticsPlugin } from "./analytics.js";
export type { ToolDef, ToolResult, ToolContext, ToolLifecycleHook, RenderHint, ToolErrorCode, ToolMiddleware, ToolGroup, ToolVersion, ToolCallRecord, ToolStats } from "./types.js";
export { errorResult } from "./types.js";
export { ToolStatsCollector } from "./tool-stats.js";
export { createMemoryWriteTool } from "./memory-write.js";
export { createMemorySearchTool } from "./memory-search.js";

export interface CreateToolRegistryOptions {
  cwd: string;
  security?: SecurityConfig;
  sessionStore?: SessionStore;
  /** If provided, registers memory_write and memory_search tools. */
  memoryStore?: MemoryStore;
}

export interface ToolRegistryBundle {
  registry: ToolRegistry;
  security: SecurityPlugin;
}

function detectWorkspaceRoot(cwd: string): string {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return root || cwd;
  } catch {
    return cwd;
  }
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
  const permissionRules = loadPermissionRules(opts.cwd);
  const security = new SecurityPlugin({
    ...permissionRules,
    ...opts.security,
    workdir: opts.security?.workdir ?? detectWorkspaceRoot(opts.cwd),
  });
  registry.use(security);

  // Register AnalyticsPlugin (session JSONL writing)
  if (opts.sessionStore) {
    registry.use(new AnalyticsPlugin(opts.sessionStore));
  }

  // Register memory tools (optional)
  if (opts.memoryStore) {
    registry.register(createMemoryWriteTool());
    registry.register(createMemorySearchTool());
  }

  return { registry, security };
}
