import {
  SUBAGENT_TOOL_NAME,
  buildSubagentToolSchema,
} from "../../../agent/subagent.js";
import type { AgentDefinition } from "../../../agent/subagent.js";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  buildAskUserQuestionSchema,
} from "../../../tools/ask-user-question.js";
import type { IntentSignalLike, ReplContext, SkillBundleLike } from "../../context.js";
import type { IntentDomain, PromptIntent, RenderedPrompt } from "../../../prompt/index.js";
import type { Tool } from "../../../types/index.js";

export interface PreparedTurnSetup {
  activeTools: Tool[];
  activeSystem: string;
  activeExecutors: SkillBundleLike["executors"] | undefined;
  resolvedPrompt: RenderedPrompt | undefined;
}

const INTENT_DOMAINS = new Set<IntentDomain>(["chat", "code", "search", "writing", "analysis", "other"]);

export function mergeSystemPrompts(...parts: Array<string | undefined>): string {
  return parts.map((p) => p?.trim()).filter(Boolean).join("\n\n");
}

export function normalizePromptIntent(intent: Partial<IntentSignalLike> | null | undefined): PromptIntent {
  const rawLevel = intent?.level;
  const level = rawLevel === 0 || rawLevel === 1 || rawLevel === 2 || rawLevel === 3 ? rawLevel : 0;
  const rawDomain = intent?.domain;
  const domain = rawDomain && INTENT_DOMAINS.has(rawDomain as IntentDomain)
    ? rawDomain as IntentDomain
    : "chat";
  return {
    domain,
    level,
    needs_tools: intent?.needs_tools ?? false,
  };
}

function hasTool(tools: Tool[], name: string): boolean {
  return tools.some((tool) => tool.name === name);
}

export function prepareTurnSetup(options: {
  ctx: ReplContext;
  intent: PromptIntent;
  agentDefinitions: AgentDefinition[];
  projectSystem?: string;
}): PreparedTurnSetup {
  const { ctx, intent, agentDefinitions, projectSystem } = options;
  const skillBundle = ctx.resolveSkillBundle?.(intent satisfies IntentSignalLike);
  const registryTools = ctx.tools;
  const skillExtras = (skillBundle?.tools ?? []).filter((tool) => !hasTool(registryTools, tool.name));
  const activeToolsWithoutAgent = skillExtras.length ? [...registryTools, ...skillExtras] : registryTools;
  const agentToolSchema = buildSubagentToolSchema(agentDefinitions);
  const withAgent = hasTool(activeToolsWithoutAgent, SUBAGENT_TOOL_NAME)
    ? activeToolsWithoutAgent
    : [...activeToolsWithoutAgent, agentToolSchema];
  const activeTools = hasTool(withAgent, ASK_USER_QUESTION_TOOL_NAME)
    ? withAgent
    : [...withAgent, buildAskUserQuestionSchema()];
  const resolvedPrompt = ctx.promptStore.resolve(intent) ?? undefined;
  const baseSystem = resolvedPrompt?.system ?? "You are Vera, a helpful assistant.";
  const activeSystem = mergeSystemPrompts(skillBundle?.system ?? baseSystem, projectSystem);

  return {
    activeTools,
    activeSystem,
    activeExecutors: skillBundle?.executors,
    resolvedPrompt,
  };
}
