// Tool Runtime 入口 — 构建完整注册表

import { execFileSync } from "node:child_process";
import { ToolRegistry } from "./registry.js";
import { loadEnabledPluginTools, ToolHost, type PluginToolLoadResult } from "./tool-host.js";
import { SecurityPlugin } from "./security.js";
import type { SecurityConfig } from "./security.js";
import { AnalyticsPlugin } from "./analytics.js";
import type { SessionStore } from "../session/index.js";
import { loadPermissionRules } from "./permission-rules.js";
import type { MemoryStore } from "../memory/store.js";
import type { UserDataStore } from "../storage/user-data.js";
import type { VectorStore, EmbeddingAdapter } from "../rag/types.js";
import type { SandboxProvider } from "../sandbox/types.js";
import type { ObjectStore } from "../storage/object-store.js";
import {
  createBuiltinToolContributions,
  registerBuiltinToolContributions,
  type BuiltinToolContribution,
  type BuiltinToolContributionOptions,
} from "./builtin-tools.js";

export { ToolRegistry } from "./registry.js";
export { ToolHost, ToolRegistryAdapter, loadEnabledPluginTools } from "./tool-host.js";
export {
  createBuiltinToolContributions,
  registerBuiltinToolContributions,
} from "./builtin-tools.js";
export { SecurityPlugin } from "./security.js";
export type { SecurityConfig } from "./security.js";
export { AnalyticsPlugin } from "./analytics.js";
export type { ToolDef, ToolResult, ToolContext, ToolLifecycleHook, RenderHint, ToolErrorCode, ToolMiddleware, ToolGroup, ToolVersion, ToolCallRecord, ToolStats } from "./types.js";
export type {
  PluginToolLoadResult,
  ToolAuditSink,
  ToolAuditSource,
  ToolCallEvent,
  ToolCapabilityInput,
  ToolGuardrail,
  ToolHostOptions,
} from "./tool-host.js";
export type { BuiltinToolContribution, BuiltinToolContributionOptions } from "./builtin-tools.js";
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
export { createFileUploadTool, createFileDownloadTool, createFileListTool, createStorageTools } from "./storage.js";
export type { FileUploadArgs, FileDownloadArgs, FileListArgs, StorageToolSet } from "./storage.js";
import type { LLMAdapter } from "../adapters/base.js";
import type { LlmService } from "../adapters/llm-service.js";

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
  /** If provided, registers visual_analyze tool with purpose-aware LLM calls. */
  llmService?: LlmService;
  /** Default model for LLM calls within tools. */
  defaultModel?: string;
  /** If provided, registers sandbox_exec / sandbox_upload / sandbox_download tools. */
  sandboxProvider?: SandboxProvider;
  /** If provided, registers file_upload / file_download / file_list tools. */
  objectStore?: ObjectStore;
  /** If provided, registers data_save / data_load / data_list / data_delete tools. */
  userDataStore?: UserDataStore;
}

export interface ToolRegistryBundle {
  registry: ToolRegistry;
  toolHost: ToolHost;
  security: SecurityPlugin;
  builtinContributions: BuiltinToolContribution[];
  loadPlugins: () => Promise<PluginToolLoadResult>;
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
  const toolHost = new ToolHost({ registry, adoptRegistryTools: false });
  const builtinContributions = registerBuiltinToolContributions(toolHost, opts);

  // Register SecurityPlugin (runs first — short-circuits on denial)
  const permissionRules = loadPermissionRules(opts.cwd);
  const security = new SecurityPlugin({
    ...permissionRules,
    ...opts.security,
    workdir: opts.security?.workdir ?? detectWorkspaceRoot(opts.cwd),
  });
  toolHost.useGuardrail(security);
  registry.use(security);

  // Register AnalyticsPlugin (session JSONL writing)
  if (opts.sessionStore) {
    const analytics = new AnalyticsPlugin(opts.sessionStore);
    registry.use(analytics);
    toolHost.addAuditSink({
      name: analytics.name,
      onToolResult: async (event) => {
        if (event.source !== "registry") {
          await analytics.onToolResult(event);
        }
      },
    });
  }

  return {
    registry,
    toolHost,
    security,
    builtinContributions,
    loadPlugins: () => loadEnabledPluginTools(toolHost, opts.cwd),
  };
}
