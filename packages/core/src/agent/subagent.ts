import {
  execFileSync,
} from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import {
  basename,
  extname,
  join,
  resolve,
} from "node:path";
import { RemoteRunnerError } from "../errors.js";
import { randomUUID } from "node:crypto";
import type { EventBus } from "@open-vera/plugin-runtime";
import type { LLMAdapter } from "../adapters/base.js";
import type { Tool, Usage } from "../types/index.js";
import type { AgentLlmServiceLike, ToolHandler } from "./loop.js";
import { streamAgent } from "./loop.js";
import { calculateCost, SessionStore } from "../session/index.js";
import { createBranchWorktree } from "../worktree/index.js";
import { globalVeraDir, projectResourcePath } from "../config/paths.js";

export const SUBAGENT_TOOL_NAME = "agent";

export type AgentPermissionMode = "readonly" | "default";

export interface AgentDefinition {
  agentType: string;
  description: string;
  systemPrompt: string;
  tools: "*" | string[];
  disallowedTools?: string[];
  permissionMode: AgentPermissionMode;
  maxTurns?: number;
  source?: "built-in" | "user" | "project";
  path?: string;
}

const READONLY_TOOLS = ["read_file", "list_dir", "glob", "grep"];

export const BUILTIN_AGENT_DEFINITIONS: AgentDefinition[] = [
  {
    agentType: "general-purpose",
    description: "General-purpose subagent for focused multi-step tasks.",
    systemPrompt: "You are a general-purpose Vera subagent.",
    tools: "*",
    permissionMode: "default",
    maxTurns: 200,
  },
  {
    agentType: "explore",
    description: "Read-only subagent for codebase exploration and research.",
    systemPrompt: "You are a read-only exploration subagent. Inspect and report; do not modify files.",
    tools: READONLY_TOOLS,
    permissionMode: "readonly",
    maxTurns: 80,
  },
  {
    agentType: "plan",
    description: "Read-only planning subagent for design and implementation plans.",
    systemPrompt: "You are a planning subagent. Produce concise plans grounded in the available context.",
    tools: READONLY_TOOLS,
    permissionMode: "readonly",
    maxTurns: 40,
  },
];

const SUBAGENT_SYSTEM_SUFFIX = `

You are a Vera subagent running inside a parent agent turn.
Focus only on the delegated task. Use tools as needed, then return a concise final report with:
- Result
- Key evidence or files checked
- Any blockers or risks
Do not ask the user questions unless the task is impossible without more input.`;

export const subagentToolSchema: Tool = {
  name: SUBAGENT_TOOL_NAME,
  description:
    "Launch a focused subagent for multi-step investigation or implementation. " +
    "Use this when a task benefits from isolated exploration before reporting back.",
  parameters: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "A short 3-5 word description of the task.",
      },
      prompt: {
        type: "string",
        description: "The task for the agent to perform.",
      },
      subagent_type: {
        type: "string",
        description: "The type of specialized agent to use.",
        enum: BUILTIN_AGENT_DEFINITIONS.map((agent) => agent.agentType),
      },
      task: {
        type: "string",
        description: "Deprecated alias for prompt.",
      },
      context: {
        type: "string",
        description: "Optional relevant context, constraints, or paths for the subagent.",
      },
      subagentType: {
        type: "string",
        description: "Deprecated alias for subagent_type.",
        enum: BUILTIN_AGENT_DEFINITIONS.map((agent) => agent.agentType),
      },
      allowedTools: {
        type: "array",
        description:
          "Optional list of tool names the subagent may use. Intersected with the selected subagent type.",
        items: { type: "string" },
      },
      maxTurns: {
        type: "number",
        description: "Optional maximum number of subagent loop turns.",
      },
      isolation: {
        type: "string",
        description:
          "Optional execution isolation. Use 'try' for local worktree isolation or 'remote' for remote executor isolation.",
        enum: ["none", "try", "remote"],
      },
      run_mode: {
        type: "string",
        description: "Execution mode: sync waits for completion, background returns immediately.",
        enum: ["sync", "background"],
      },
      resume_session_id: {
        type: "string",
        description: "Optional transcript session id to resume a previous subagent route.",
      },
      resumeSessionId: {
        type: "string",
        description: "Deprecated alias for resume_session_id.",
      },
    },
    required: ["prompt"],
  },
  maxResultSizeChars: 20_000,
};

export function buildSubagentToolSchema(definitions = BUILTIN_AGENT_DEFINITIONS): Tool {
  const agentTypes = definitions.map((agent) => agent.agentType);
  return {
    ...subagentToolSchema,
    parameters: {
      ...subagentToolSchema.parameters,
      properties: {
        ...subagentToolSchema.parameters.properties,
        subagent_type: {
          ...subagentToolSchema.parameters.properties.subagent_type,
          enum: agentTypes,
        },
        subagentType: {
          ...subagentToolSchema.parameters.properties.subagentType,
          enum: agentTypes,
        },
      },
    },
  };
}

export interface RunSubagentToolOptions {
  args: Record<string, unknown>;
  adapter: LLMAdapter;
  model: string;
  tools: Tool[];
  system?: string;
  runDir?: string;
  signal?: AbortSignal;
  onToolCall: ToolHandler;
  onUsage?: (usage: Usage) => void;
  eventBus?: EventBus;
  llmService?: AgentLlmServiceLike;
  traceId?: string;
  cwd?: string;
  provider?: string;
  parentSessionId?: string;
  definitions?: AgentDefinition[];
  createToolHandlerForCwd?: (opts: {
    cwd: string;
    sessionStore?: SessionStore;
  }) => ToolHandler;
  remoteExecutor?: (opts: {
    task: string;
    description?: string;
    context?: string;
    definition: AgentDefinition;
    prompt: string;
    model: string;
    system?: string;
    tools: Tool[];
    maxTurns?: number;
    signal?: AbortSignal;
    onUsage?: (usage: Usage) => void;
    parentSessionId?: string;
  }) => Promise<{
    content: string;
    transcriptId?: string;
    toolCalls?: string[];
    location?: string;
  }>;
}

export interface LoadAgentDefinitionsOptions {
  cwd: string;
  includeUser?: boolean;
}

export interface RunSubagentToolResult {
  ok: boolean;
  content: string;
}

export type SubagentJobStatus = "running" | "succeeded" | "failed";

export interface SubagentBackgroundJob {
  jobId: string;
  status: SubagentJobStatus;
  agentType: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  transcriptId?: string;
  result?: string;
  error?: string;
}

const BACKGROUND_SUBAGENT_JOBS = new Map<string, SubagentBackgroundJob>();

export function listBackgroundSubagentJobs(): SubagentBackgroundJob[] {
  return [...BACKGROUND_SUBAGENT_JOBS.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getBackgroundSubagentJob(jobIdOrPrefix: string): SubagentBackgroundJob | undefined {
  if (!jobIdOrPrefix) return undefined;
  if (BACKGROUND_SUBAGENT_JOBS.has(jobIdOrPrefix)) return BACKGROUND_SUBAGENT_JOBS.get(jobIdOrPrefix);
  const matches = [...BACKGROUND_SUBAGENT_JOBS.values()].filter((job) => job.jobId.startsWith(jobIdOrPrefix));
  return matches.length === 1 ? matches[0] : undefined;
}

interface ResolvedRemoteExecutorContext {
  task: string;
  description?: string;
  context?: string;
  definition: AgentDefinition;
  prompt: string;
  model: string;
  system?: string;
  tools: Tool[];
  maxTurns?: number;
  signal?: AbortSignal;
  onUsage?: (usage: Usage) => void;
  parentSessionId?: string;
}

export async function runSubagentTool({
  args,
  adapter,
  model,
  tools,
  system,
  runDir,
  signal,
  onToolCall,
  onUsage,
  eventBus,
  llmService,
  traceId,
  cwd,
  provider,
  parentSessionId,
  definitions = BUILTIN_AGENT_DEFINITIONS,
  createToolHandlerForCwd,
  remoteExecutor,
}: RunSubagentToolOptions): Promise<RunSubagentToolResult> {
  const task = stringArg(args.prompt) || stringArg(args.task);
  if (!task) {
    return { ok: false, content: "agent requires a non-empty prompt string." };
  }

  const requestedType = stringArg(args.subagent_type) || stringArg(args.subagentType) || "general-purpose";
  const definition = definitions.find((agent) => normalizeAgentType(agent.agentType) === normalizeAgentType(requestedType));
  if (!definition) {
    return { ok: false, content: `Unknown subagent_type "${requestedType}".` };
  }

  const description = stringArg(args.description);
  const context = stringArg(args.context);
  const maxTurns = typeof args.maxTurns === "number" && Number.isFinite(args.maxTurns)
    ? Math.max(1, Math.floor(args.maxTurns))
    : definition.maxTurns;
  const allowedTools = Array.isArray(args.allowedTools)
    ? new Set(args.allowedTools.filter((name): name is string => typeof name === "string"))
    : null;
  const definitionTools = allowedToolSetForDefinition(definition);
  const disallowedTools = new Set(definition.disallowedTools ?? []);
  const isolation = stringArg(args.isolation) || "none";
  if (isolation !== "none" && isolation !== "try" && isolation !== "remote") {
    return { ok: false, content: `Unknown subagent isolation "${isolation}".` };
  }
  const runMode = stringArg(args.run_mode) || "sync";
  if (runMode !== "sync" && runMode !== "background") {
    return { ok: false, content: `Unknown agent run_mode "${runMode}".` };
  }
  const resumeSessionId = stringArg(args.resume_session_id) || stringArg(args.resumeSessionId);
  if (resumeSessionId && isolation !== "none") {
    return { ok: false, content: "resume_session_id cannot be used with isolation." };
  }

  const childTools = tools.filter((tool) => {
    if (tool.name === SUBAGENT_TOOL_NAME) return false;
    if (definitionTools && !definitionTools.has(tool.name)) return false;
    if (disallowedTools.has(tool.name)) return false;
    return allowedTools ? allowedTools.has(tool.name) : true;
  });
  const childToolNames = new Set(childTools.map((tool) => tool.name));
  const childToolCalls: string[] = [];

  let childCwd = cwd;
  let worktree:
    | {
        worktreePath: string;
        worktreeBranch: string;
        baseCommit: string;
      }
    | undefined;
  if (isolation === "try") {
    if (!cwd) {
      return { ok: false, content: "agent isolation 'try' requires a cwd." };
    }
    try {
      worktree = createBranchWorktree(cwd, subagentTrySlug(description || task, definition.agentType));
      childCwd = worktree.worktreePath;
    } catch (err) {
      return {
        ok: false,
        content: `Failed to create subagent try worktree: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  let resumedSession:
    | {
        sessionId: string;
        cwd: string;
        resumeContext: string;
      }
    | undefined;
  if (resumeSessionId) {
    try {
      const loaded = SessionStore.loadSession(resumeSessionId, cwd);
      childCwd = loaded.cwd;
      resumedSession = {
        sessionId: loaded.sessionId,
        cwd: loaded.cwd,
        resumeContext: summarizeHistoryForResume(loaded.history),
      };
    } catch (err) {
      return {
        ok: false,
        content: `Failed to resume subagent session "${resumeSessionId}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const prompt = [
    description ? `Description:\n${description}` : "",
    resumedSession ? `Resume context:\n${resumedSession.resumeContext}` : "",
    `Task:\n${task}`,
    context ? `Context:\n${context}` : "",
  ].filter(Boolean).join("\n\n");
  const childStore = isolation === "remote" && !remoteExecutor
    ? childCwd
      ? new SessionStore({ cwd: childCwd })
      : undefined
    : isolation === "remote"
    ? undefined
    : childCwd
    ? new SessionStore({ cwd: childCwd, ...(resumedSession ? { sessionId: resumedSession.sessionId } : {}) })
    : undefined;
  const childToolHandler = worktree && createToolHandlerForCwd
    ? createToolHandlerForCwd({ cwd: worktree.worktreePath, sessionStore: childStore })
    : onToolCall;
  const startedAt = Date.now();
  let childUsage: Usage = { input_tokens: 0, output_tokens: 0 };
  let childCostUsd = 0;
  if (!resumedSession) childStore?.writeStart(model, provider ?? "unknown");
  if (!resumedSession && childStore && parentSessionId) {
    childStore.writeBranch({
      parentSessionId,
      title: `subagent:${definition.agentType}`,
      status: "active",
      worktreePath: worktree?.worktreePath,
      worktreeBranch: worktree?.worktreeBranch,
      baseCommit: worktree?.baseCommit,
    });
  }
  const childUserUuid = childStore?.writeUser(prompt);

  const runChild = async (): Promise<{
    finalText: string;
    toolCalls: string[];
    transcriptId?: string;
    worktreePath?: string;
  }> => {
    if (isolation === "remote") {
      const remoteExec = remoteExecutor ?? createDefaultRemoteExecutor({
        adapter,
        onToolCall,
        childToolNames,
        childToolCalls,
        childStore,
        childUserUuid,
        signal,
        eventBus,
        llmService,
        parentSessionId,
      });
      const remote = await remoteExec({
        task,
        ...(description ? { description } : {}),
        ...(context ? { context } : {}),
        definition,
        prompt,
        model,
        system: [system, definition.systemPrompt, SUBAGENT_SYSTEM_SUFFIX].filter(Boolean).join("\n\n"),
        tools: childTools,
        ...(maxTurns ? { maxTurns } : {}),
        signal,
        onUsage,
        parentSessionId,
      });
      return {
        finalText: remote.content,
        toolCalls: remote.toolCalls ?? [],
        transcriptId: remote.transcriptId,
        worktreePath: remote.location ? `remote:${remote.location}` : "remote",
      };
    }

    const finalText = await streamAgent(
      prompt,
      {
        adapter,
        eventBus,
        llmService,
        sessionId: childStore?.sessionId ?? parentSessionId,
        traceId: traceId ?? `subagent:${definition.agentType}`,
        model,
        tools: childTools,
        system: [system, definition.systemPrompt, SUBAGENT_SYSTEM_SUFFIX].filter(Boolean).join("\n\n"),
        maxTurns,
        runDir: worktree?.worktreePath ?? runDir,
        signal,
        onUsage: (usage) => {
          childUsage = addUsage(childUsage, usage);
          childCostUsd += calculateCost(usage, model);
          onUsage?.(usage);
        },
        onToolCall: async (name, toolArgs) => {
          if (!childToolNames.has(name)) {
            return `Tool "${name}" is not available to this subagent.`;
          }
          childToolCalls.push(name);
          const toolCallUuid = childStore?.writeToolCall({
            parentUuid: childUserUuid ?? childStore.sessionId,
            toolName: name,
            toolCallId: name,
            arguments: toolArgs,
          });
          const content = await childToolHandler(name, toolArgs);
          if (childStore && toolCallUuid) {
            childStore.writeToolResult({ parentUuid: toolCallUuid, toolCallId: name, content });
          }
          return content;
        },
      },
      () => {},
    );
    childStore?.writeAssistant({
      parentUuid: childUserUuid ?? childStore.sessionId,
      content: finalText,
      model,
      provider: provider ?? "unknown",
      stopReason: "end_turn",
      usage: childUsage,
      turn: 1,
      latencyMs: Date.now() - startedAt,
      toolCalls: childToolCalls,
      status: "ok",
    });
    childStore?.writeEnd(childUsage, childCostUsd, 1, task);
    return {
      finalText,
      toolCalls: [...childToolCalls],
      transcriptId: childStore?.sessionId,
      worktreePath: worktree?.worktreePath,
    };
  };

  if (runMode === "background") {
    const jobId = `subjob-${randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();
    BACKGROUND_SUBAGENT_JOBS.set(jobId, {
      jobId,
      status: "running",
      agentType: definition.agentType,
      prompt: task,
      createdAt: now,
      updatedAt: now,
      transcriptId: childStore?.sessionId,
    });
    void (async () => {
      try {
        const done = await runChild();
        const finishedAt = new Date().toISOString();
        BACKGROUND_SUBAGENT_JOBS.set(jobId, {
          ...(BACKGROUND_SUBAGENT_JOBS.get(jobId) ?? {
            jobId,
            agentType: definition.agentType,
            prompt: task,
            createdAt: now,
          }),
          status: "succeeded",
          updatedAt: finishedAt,
          transcriptId: done.transcriptId,
          result: done.finalText.trim() || "(no final text)",
        });
      } catch (err) {
        const failedAt = new Date().toISOString();
        BACKGROUND_SUBAGENT_JOBS.set(jobId, {
          ...(BACKGROUND_SUBAGENT_JOBS.get(jobId) ?? {
            jobId,
            agentType: definition.agentType,
            prompt: task,
            createdAt: now,
          }),
          status: "failed",
          updatedAt: failedAt,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return {
      ok: true,
      content: [
        `Subagent (${definition.agentType}) started in background.`,
        `Job: ${jobId}`,
        childStore ? `Transcript: ${childStore.sessionId}` : "",
        "Use /subjobs to inspect status.",
      ].filter(Boolean).join("\n"),
    };
  }

  const done = await runChild();
  return {
    ok: true,
    content: [
      `Subagent (${definition.agentType}) result:`,
      done.finalText.trim() || "(no final text)",
      done.toolCalls.length > 0 ? `\nTools used: ${[...new Set(done.toolCalls)].join(", ")}` : "",
      done.worktreePath
        ? isolation === "remote"
          ? `Isolation: ${done.worktreePath}`
          : `Isolation: try worktree ${done.worktreePath}`
        : "",
      done.transcriptId ? `Transcript: ${done.transcriptId}` : "",
    ].filter(Boolean).join("\n"),
  };
}

function subagentTrySlug(input: string, agentType: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const type = agentType
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 16);
  return `subagent-${type || "agent"}-${base || "try"}-${randomUUID().slice(0, 8)}`;
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_creation_input_tokens:
      (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens:
      (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
  };
}

export function loadAgentDefinitions({
  cwd,
  includeUser = true,
}: LoadAgentDefinitionsOptions): AgentDefinition[] {
  const definitions = new Map<string, AgentDefinition>();
  for (const definition of BUILTIN_AGENT_DEFINITIONS) {
    definitions.set(normalizeAgentType(definition.agentType), { ...definition, source: "built-in" });
  }

  if (includeUser) {
    for (const definition of readAgentsDir(join(globalVeraDir(), "agents"), "user")) {
      definitions.set(normalizeAgentType(definition.agentType), definition);
    }
  }

  for (const definition of readAgentsDir(projectResourcePath(resolve(cwd), "agents"), "project")) {
    definitions.set(normalizeAgentType(definition.agentType), definition);
  }

  return [...definitions.values()];
}

function readAgentsDir(dir: string, source: "user" | "project"): AgentDefinition[] {
  if (!existsSync(dir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  return entries
    .filter((entry) => extname(entry).toLowerCase() === ".md")
    .sort()
    .flatMap((entry) => {
      const path = join(dir, entry);
      try {
        const raw = readFileSync(path, "utf8");
        const parsed = parseAgentMarkdown(raw);
        const agentType = parsed.fields.agentType || basename(entry, ".md");
        if (!parsed.content.trim()) return [];
        return [{
          agentType,
          description: parsed.fields.description || `Custom ${agentType} subagent.`,
          systemPrompt: parsed.content.trim(),
          tools: parsed.fields.tools ?? "*",
          ...(parsed.fields.disallowedTools ? { disallowedTools: parsed.fields.disallowedTools } : {}),
          permissionMode: parsed.fields.permissionMode ?? "default",
          ...(parsed.fields.maxTurns !== undefined ? { maxTurns: parsed.fields.maxTurns } : {}),
          source,
          path,
        }];
      } catch {
        return [];
      }
    });
}

function parseAgentMarkdown(raw: string): {
  content: string;
  fields: {
    agentType?: string;
    description?: string;
    tools?: "*" | string[];
    disallowedTools?: string[];
    permissionMode?: AgentPermissionMode;
    maxTurns?: number;
  };
} {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") return { content: raw, fields: {} };
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end === -1) return { content: raw, fields: {} };

  const fields: ReturnType<typeof parseAgentMarkdown>["fields"] = {};
  for (const line of lines.slice(1, end)) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = unquote(line.slice(index + 1).trim());
    if (!value) continue;
    if (key === "name" || key === "agentType" || key === "agent_type") {
      fields.agentType = value;
    } else if (key === "description" || key === "whenToUse") {
      fields.description = value;
    } else if (key === "tools") {
      const tools = parseList(value);
      fields.tools = tools.includes("*") ? "*" : tools;
    } else if (key === "disallowedTools" || key === "disallowed_tools") {
      fields.disallowedTools = parseList(value);
    } else if (key === "permissionMode" || key === "permission_mode") {
      fields.permissionMode = value === "readonly" ? "readonly" : "default";
    } else if (key === "maxTurns" || key === "max_turns") {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) fields.maxTurns = Math.floor(parsed);
    }
  }

  return { content: lines.slice(end + 1).join("\n"), fields };
}

function parseList(value: string): string[] {
  return value
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(/[,\s]+/)
    .map((item) => unquote(item.trim()))
    .filter(Boolean);
}

function allowedToolSetForDefinition(definition: AgentDefinition): Set<string> | null {
  const explicit = definition.tools === "*" ? null : new Set(definition.tools);
  if (definition.permissionMode !== "readonly") return explicit;

  const readonly = new Set(READONLY_TOOLS);
  if (!explicit) return readonly;
  return new Set([...explicit].filter((tool) => readonly.has(tool)));
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

function stringArg(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAgentType(value: string): string {
  const normalized = value.toLowerCase().replaceAll("_", "-");
  return normalized === "general" ? "general-purpose" : normalized;
}

function summarizeHistoryForResume(history: Array<{ role: string; content: string | unknown }>): string {
  const tail = history.slice(-12);
  if (tail.length === 0) return "(no prior messages)";
  return tail
    .map((msg) => {
      const contentStr = typeof msg.content === "string" ? msg.content : String(msg.content);
      return `${msg.role}: ${contentStr.replace(/\s+/g, " ").trim().slice(0, 280)}`;
    })
    .join("\n");
}

function createDefaultRemoteExecutor(input: {
  adapter: LLMAdapter;
  onToolCall: ToolHandler;
  childToolNames: Set<string>;
  childToolCalls: string[];
  childStore?: SessionStore;
  childUserUuid?: string;
  signal?: AbortSignal;
  eventBus?: EventBus;
  llmService?: AgentLlmServiceLike;
  parentSessionId?: string;
}): (opts: ResolvedRemoteExecutorContext) => Promise<{
  content: string;
  transcriptId?: string;
  toolCalls?: string[];
  location?: string;
}> {
  return async (opts) => {
    const external = tryRunExternalRemoteRunner({
      task: opts.task,
      ...(opts.description ? { description: opts.description } : {}),
      ...(opts.context ? { context: opts.context } : {}),
      agentType: opts.definition.agentType,
      prompt: opts.prompt,
      model: opts.model,
      ...(opts.system ? { system: opts.system } : {}),
      maxTurns: opts.maxTurns,
      toolNames: opts.tools.map((t) => t.name),
      ...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
    });
    if (external) {
      return external;
    }

    const result = await streamAgent(
      opts.prompt,
      {
        adapter: input.adapter,
        eventBus: input.eventBus,
        llmService: input.llmService,
        sessionId: input.childStore?.sessionId ?? opts.parentSessionId ?? input.parentSessionId,
        traceId: `subagent:remote:${opts.definition.agentType}`,
        model: opts.model,
        tools: opts.tools,
        system: opts.system,
        maxTurns: opts.maxTurns,
        signal: input.signal,
        onUsage: opts.onUsage,
        onToolCall: async (name, toolArgs) => {
          if (!input.childToolNames.has(name)) {
            return `Tool "${name}" is not available to this subagent.`;
          }
          input.childToolCalls.push(name);
          const toolCallUuid = input.childStore?.writeToolCall({
            parentUuid: input.childUserUuid ?? input.childStore?.sessionId ?? "remote-subagent",
            toolName: name,
            toolCallId: name,
            arguments: toolArgs,
          });
          const content = await input.onToolCall(name, toolArgs);
          if (input.childStore && toolCallUuid) {
            input.childStore.writeToolResult({ parentUuid: toolCallUuid, toolCallId: name, content });
          }
          return content;
        },
      },
      () => {},
    );

    return {
      content: result,
      transcriptId: input.childStore?.sessionId,
      toolCalls: [...new Set(input.childToolCalls)],
      location: "local-default",
    };
  };
}

function tryRunExternalRemoteRunner(payload: {
  task: string;
  description?: string;
  context?: string;
  agentType: string;
  prompt: string;
  model: string;
  system?: string;
  maxTurns?: number;
  toolNames: string[];
  parentSessionId?: string;
}): {
  content: string;
  transcriptId?: string;
  toolCalls?: string[];
  location?: string;
} | null {
  const runnerCmd = process.env.VERA_SUBAGENT_REMOTE_RUNNER?.trim();
  if (!runnerCmd) return null;

  const args = parseJsonStringArray(process.env.VERA_SUBAGENT_REMOTE_RUNNER_ARGS);
  try {
    const stdout = execFileSync(runnerCmd, args, {
      input: JSON.stringify(payload),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const parsed = JSON.parse(stdout) as {
      content?: unknown;
      transcriptId?: unknown;
      toolCalls?: unknown;
      location?: unknown;
    };
    const content = typeof parsed.content === "string" ? parsed.content : "(empty remote result)";
    const transcriptId = typeof parsed.transcriptId === "string" ? parsed.transcriptId : undefined;
    const toolCalls = Array.isArray(parsed.toolCalls)
      ? parsed.toolCalls.filter((name): name is string => typeof name === "string")
      : undefined;
    const location = typeof parsed.location === "string" ? parsed.location : `external:${runnerCmd}`;
    return { content, ...(transcriptId ? { transcriptId } : {}), ...(toolCalls ? { toolCalls } : {}), location };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new RemoteRunnerError(runnerCmd, detail);
  }
}

function parseJsonStringArray(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
