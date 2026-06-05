import type { LLMAdapter } from "../adapters/base.js";
import type { LlmService } from "../adapters/llm-service.js";
import type { MemoryStore } from "../memory/store.js";
import type { EmbeddingAdapter, VectorStore } from "../rag/types.js";
import type { SandboxProvider } from "../sandbox/types.js";
import type { ObjectStore } from "../storage/object-store.js";
import {
  createDataDeleteTool,
  createDataListTool,
  createDataLoadTool,
  createDataSaveTool,
  type UserDataStore,
} from "../storage/user-data.js";
import { bashTool } from "./bash.js";
import { browserTool } from "./browser.js";
import { computerUseTool } from "./computer-use.js";
import { desktopAccessibilityTool } from "./desktop-accessibility.js";
import { desktopInputTool } from "./desktop-input.js";
import { desktopScreenshotTool } from "./desktop-screenshot.js";
import { desktopScriptTool } from "./desktop-script.js";
import { editFileTool } from "./edit-file.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { createKnowledgeSearchTool } from "./knowledge-search.js";
import { listDirTool } from "./list-dir.js";
import { createMemorySearchTool } from "./memory-search.js";
import { createMemoryWriteTool } from "./memory-write.js";
import { readFileTool } from "./read-file.js";
import { createSandboxDownloadTool, createSandboxExecTool, createSandboxUploadTool } from "./sandbox.js";
import { createFileDownloadTool, createFileListTool, createFileUploadTool } from "./storage.js";
import type { ToolHost } from "./tool-host.js";
import type { ToolDef } from "./types.js";
import { createVisualAnalyzeTool } from "./visual-analyze.js";
import { writeFileTool } from "./write-file.js";

type AnyToolDef = ToolDef<any>;

export interface BuiltinToolContribution {
  ownerPluginId: string;
  source: string;
  tools: AnyToolDef[];
  metadata?: Record<string, unknown>;
}

export interface BuiltinToolContributionOptions {
  memoryStore?: MemoryStore;
  vectorStore?: VectorStore;
  embeddingAdapter?: EmbeddingAdapter;
  llmAdapter?: LLMAdapter;
  llmService?: LlmService;
  defaultModel?: string;
  sandboxProvider?: SandboxProvider;
  objectStore?: ObjectStore;
  userDataStore?: UserDataStore;
}

export function createBuiltinToolContributions(
  opts: BuiltinToolContributionOptions,
): BuiltinToolContribution[] {
  const contributions: BuiltinToolContribution[] = [
    builtinContribution("builtin-tools-fs", [
      readFileTool,
      writeFileTool,
      editFileTool,
      listDirTool,
      globTool,
      grepTool,
    ], {
      category: "filesystem",
    }),
    builtinContribution("builtin-tools-shell", [bashTool], {
      category: "shell",
    }),
    builtinContribution("builtin-browser", [browserTool], {
      category: "browser",
    }),
    builtinContribution("builtin-computer-use", [
      desktopScreenshotTool,
      desktopInputTool,
      desktopScriptTool,
      desktopAccessibilityTool,
      computerUseTool,
    ], {
      category: "computer-use",
    }),
  ];

  if (opts.memoryStore) {
    contributions.push(builtinContribution("builtin-memory", [
      createMemoryWriteTool(),
      createMemorySearchTool(),
    ], {
      category: "memory",
      dependencies: ["memory-store"],
    }));
  }

  if (opts.vectorStore && opts.embeddingAdapter) {
    contributions.push(builtinContribution("builtin-rag", [createKnowledgeSearchTool()], {
      category: "rag",
      dependencies: ["vector-store", "embedding-adapter"],
    }));
  }

  if (opts.llmService ?? opts.llmAdapter) {
    contributions.push(builtinContribution("builtin-computer-use", [
      createVisualAnalyzeTool(opts.llmService ?? opts.llmAdapter!, opts.defaultModel),
    ], {
      category: "computer-use",
      dependencies: ["llm-vision"],
    }));
  }

  if (opts.sandboxProvider) {
    contributions.push(builtinContribution("builtin-sandbox-tools", [
      createSandboxExecTool(),
      createSandboxUploadTool(),
      createSandboxDownloadTool(),
    ], {
      category: "sandbox",
      dependencies: ["sandbox-provider"],
    }));
  }

  if (opts.objectStore) {
    contributions.push(builtinContribution("builtin-storage-tools", [
      createFileUploadTool(),
      createFileDownloadTool(),
      createFileListTool(),
    ], {
      category: "object-storage",
      dependencies: ["object-store"],
    }));
  }

  if (opts.userDataStore) {
    contributions.push(builtinContribution("builtin-user-data", [
      createDataSaveTool(opts.userDataStore),
      createDataLoadTool(opts.userDataStore),
      createDataListTool(opts.userDataStore),
      createDataDeleteTool(opts.userDataStore),
    ], {
      category: "user-data",
      dependencies: ["user-data-store"],
    }));
  }

  return contributions;
}

export function registerBuiltinToolContributions(
  toolHost: ToolHost,
  opts: BuiltinToolContributionOptions,
): BuiltinToolContribution[] {
  const contributions = createBuiltinToolContributions(opts);
  for (const contribution of contributions) {
    for (const tool of contribution.tools) {
      toolHost.registerCapability({
        ...tool,
        ownerPluginId: contribution.ownerPluginId,
        source: contribution.source,
        metadata: {
          builtin: true,
          builtinPluginId: contribution.ownerPluginId,
          source: contribution.source,
          ...contribution.metadata,
        },
      });
    }
  }
  return contributions;
}

function builtinContribution(
  ownerPluginId: string,
  tools: AnyToolDef[],
  metadata?: Record<string, unknown>,
): BuiltinToolContribution {
  return {
    ownerPluginId,
    source: `builtin:tool-plugin/${ownerPluginId}`,
    tools,
    ...(metadata ? { metadata } : {}),
  };
}
