import {
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  extname,
  join,
  resolve,
} from "node:path";
import { randomUUID } from "node:crypto";
import type { LLMAdapter } from "../adapters/base.js";
import type { Tool, Usage } from "../types/index.js";
import type { ToolHandler } from "./loop.js";
import { streamAgent } from "./loop.js";
import { calculateCost, SessionStore } from "../session/index.js";
import { createBranchWorktree } from "../worktree/index.js";

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
          "Optional execution isolation. Use 'try' to run the subagent in an isolated git worktree that can later be merged.",
        enum: ["none", "try"],
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
  cwd?: string;
  provider?: string;
  parentSessionId?: string;
  definitions?: AgentDefinition[];
  createToolHandlerForCwd?: (opts: {
    cwd: string;
    sessionStore?: SessionStore;
  }) => ToolHandler;
}

export interface LoadAgentDefinitionsOptions {
  cwd: string;
  includeUser?: boolean;
  homeDir?: string;
}

export interface RunSubagentToolResult {
  ok: boolean;
  content: string;
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
  cwd,
  provider,
  parentSessionId,
  definitions = BUILTIN_AGENT_DEFINITIONS,
  createToolHandlerForCwd,
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
  if (isolation !== "none" && isolation !== "try") {
    return { ok: false, content: `Unknown subagent isolation "${isolation}".` };
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

  const prompt = [
    description ? `Description:\n${description}` : "",
    `Task:\n${task}`,
    context ? `Context:\n${context}` : "",
  ].filter(Boolean).join("\n\n");
  const childStore = childCwd ? new SessionStore({ cwd: childCwd }) : undefined;
  const childToolHandler = worktree && createToolHandlerForCwd
    ? createToolHandlerForCwd({ cwd: worktree.worktreePath, sessionStore: childStore })
    : onToolCall;
  const startedAt = Date.now();
  let childUsage: Usage = { input_tokens: 0, output_tokens: 0 };
  let childCostUsd = 0;
  childStore?.writeStart(model, provider ?? "unknown");
  if (childStore && parentSessionId) {
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

  const finalText = await streamAgent(
    prompt,
    {
      adapter,
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
    ok: true,
    content: [
      `Subagent (${definition.agentType}) result:`,
      finalText.trim() || "(no final text)",
      childToolCalls.length > 0 ? `\nTools used: ${[...new Set(childToolCalls)].join(", ")}` : "",
      worktree ? `Isolation: try worktree ${worktree.worktreePath}` : "",
      childStore ? `Transcript: ${childStore.sessionId}` : "",
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
  homeDir = process.env.VERA_HOME || homedir(),
}: LoadAgentDefinitionsOptions): AgentDefinition[] {
  const definitions = new Map<string, AgentDefinition>();
  for (const definition of BUILTIN_AGENT_DEFINITIONS) {
    definitions.set(normalizeAgentType(definition.agentType), { ...definition, source: "built-in" });
  }

  if (includeUser) {
    for (const definition of readAgentsDir(join(homeDir, ".vera", "agents"), "user")) {
      definitions.set(normalizeAgentType(definition.agentType), definition);
    }
  }

  for (const definition of readAgentsDir(join(resolve(cwd), ".vera", "agents"), "project")) {
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
