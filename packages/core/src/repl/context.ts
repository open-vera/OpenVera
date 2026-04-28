import type { LLMAdapter } from "../adapters/base.js";
import type { VeraConfig } from "../config/types.js";
import type { SessionStore, LoadedSession } from "../session/index.js";
import type { Tool } from "../types/index.js";
import type { SecurityConfig, ToolRegistry, ToolRegistryBundle } from "../tools/index.js";
import type { SecurityPlugin } from "../tools/security.js";
import type { PlanExecutor } from "../plan/index.js";
import type { PromptStore } from "../prompt/index.js";

export interface IntentSignalLike {
  domain: string;
  level: number;
  needs_tools: boolean;
}

export interface SkillBundleLike {
  system: string;
  tools: Tool[];
  executors: Map<string, (args: Record<string, unknown>) => Promise<string> | string>;
}

export interface ReplContext {
  /** Logical project working directory for tools, sessions, and project context. */
  cwd: string;
  config: VeraConfig;
  adapter: LLMAdapter;
  model: string;
  tools: Tool[];
  buildAdapter: (provider: string) => LLMAdapter;
  sessionStore: SessionStore;
  registry?: ToolRegistry;
  createToolRegistry?: (opts: {
    cwd: string;
    security?: SecurityConfig;
    sessionStore?: SessionStore;
  }) => ToolRegistryBundle;
  /** PromptStore for templated system prompts and domain profiles. */
  promptStore: PromptStore;
  /** SecurityPlugin instance — exposed so App can call allowPath() after user confirms. */
  security?: SecurityPlugin;
  /** Optional: resolve skill-augmented tools + system per intent. */
  resolveSkillBundle?: (intent: IntentSignalLike) => SkillBundleLike;
  /**
   * Optional: execute a multi-step plan for complex tasks.
   * When provided, App will invoke this instead of streamAgent when intent
   * has needs_planning=true. Falls back to defaultPlanExecutor if absent.
   */
  planExecutor?: PlanExecutor;
  onResume?: (loaded: LoadedSession) => void;
  onSwitchWorkspace?: (cwd: string, sessionStore: SessionStore) => void;
  onShowSessionPicker?: () => void;
}

