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
import { browserTool } from "./browser.js";
import { desktopScreenshotTool } from "./desktop-screenshot.js";
import { desktopInputTool } from "./desktop-input.js";
import { desktopScriptTool } from "./desktop-script.js";
import { desktopAccessibilityTool } from "./desktop-accessibility.js";
import { computerUseTool } from "./computer-use.js";
import { createVisualAnalyzeTool } from "./visual-analyze.js";
import { createMemoryWriteTool } from "./memory-write.js";
import { createMemorySearchTool } from "./memory-search.js";
import type { MemoryStore } from "../memory/store.js";
import { createDataSaveTool, createDataLoadTool, createDataListTool, createDataDeleteTool } from "../storage/user-data.js";
import type { UserDataStore } from "../storage/user-data.js";
import { createKnowledgeSearchTool } from "./knowledge-search.js";
import type { VectorStore, EmbeddingAdapter } from "../rag/types.js";
import { createSandboxExecTool, createSandboxUploadTool, createSandboxDownloadTool } from "./sandbox.js";
import type { SandboxProvider } from "../sandbox/types.js";

export { ToolRegistry } from "./registry.js";
export { SecurityPlugin } from "./security.js";
export type { SecurityConfig } from "./security.js";
export { AnalyticsPlugin } from "./analytics.js";
export type { ToolDef, ToolResult, ToolContext, ToolLifecycleHook, RenderHint, ToolErrorCode, ToolMiddleware, ToolGroup, ToolVersion, ToolCallRecord, ToolStats } from "./types.js";
export { errorResult } from "./types.js";
export { ToolStatsCollector } from "./tool-stats.js";
export { createMemoryWriteTool } from "./memory-write.js";
export { createMemorySearchTool } from "./memory-search.js";
export { createKnowledgeSearchTool } from "./knowledge-search.js";
export { browserTool, closeAllBrowserSessions } from "./browser.js";
export { desktopScreenshotTool } from "./desktop-screenshot.js";
export { desktopInputTool } from "./desktop-input.js";
export { desktopScriptTool } from "./desktop-script.js";
export { desktopAccessibilityTool } from "./desktop-accessibility.js";
export { computerUseTool } from "./computer-use.js";
export { createVisualAnalyzeTool } from "./visual-analyze.js";
export { MultiStepOrchestrator, StepPatterns } from "./multi-step-orchestrator.js";
export type { StepDefinition, OrchestrationResult, OrchestratorConfig, ToolResolver, ErrorStrategy, StepCondition, StepResult } from "./multi-step-orchestrator.js";
export { OperationRecorder, replay, serializeRecording, deserializeRecording, executeWithRecording } from "./operation-recorder.js";
export type { StepRecord, OperationRecording, ReplayOptions, ReplayResult } from "./operation-recorder.js";
export { createSandboxExecTool, createSandboxUploadTool, createSandboxDownloadTool, createSandboxTools } from "./sandbox.js";
export type { SandboxExecArgs, SandboxUploadArgs, SandboxDownloadArgs, SandboxToolSet } from "./sandbox.js";
import type { LLMAdapter } from "../adapters/base.js";

export interface CreateToolRegistryOptions {
  cwd: string;
  security?: SecurityConfig;
  sessionStore?: SessionStore;
  /** If provided, registers memory_write and memory_search tools. */
  memoryStore?: MemoryStore;
  /** If provided, registers knowledge_search tool. */
  vectorStore?: VectorStore;
  embeddingAdapter?: EmbeddingAdapter;
  /** If provided, registers visual_analyze tool. */
  llmAdapter?: LLMAdapter;
  /** Default model for LLM calls within tools. */
  defaultModel?: string;
  /** If provided, registers sandbox_exec / sandbox_upload / sandbox_download tools. */
  sandboxProvider?: SandboxProvider;
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
  registry.register(browserTool);
  registry.register(desktopScreenshotTool);
  registry.register(desktopInputTool);
  registry.register(desktopScriptTool);
  registry.register(desktopAccessibilityTool);
  registry.register(computerUseTool);

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

  // Register knowledge search tool (optional)
  if (opts.vectorStore && opts.embeddingAdapter) {
    registry.register(createKnowledgeSearchTool());
  }

  // Register visual analyze tool (optional)
  if (opts.llmAdapter) {
    registry.register(createVisualAnalyzeTool(opts.llmAdapter, opts.defaultModel));
  }

  // Register sandbox tools (optional)
  if (opts.sandboxProvider) {
    registry.register(createSandboxExecTool());
    registry.register(createSandboxUploadTool());
    registry.register(createSandboxDownloadTool());
  }

  return { registry, security };
}
