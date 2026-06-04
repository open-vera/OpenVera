import type { LLMAdapter } from "@open-vera/core/adapters";
import type { AgentRunner } from "../agent/types.js";
import { RoleAgentRunner } from "../agent/role-runners.js";
import { loadFlowAgents, type FlowAgentDefinition } from "../flow-config/index.js";

export type AgentDefinition = FlowAgentDefinition;

export async function loadAgents(flowsDir: string): Promise<AgentDefinition[]> {
  return loadFlowAgents(flowsDir);
}

/**
 * Create AgentRunnerMap from agent definitions loaded from .vera/flows/agents/*.
 * Each agent's main.md frontmatter defines model/adapter,
 * markdown body becomes the system prompt.
 */
export function createRunnersFromAgents(
  agentDefs: AgentDefinition[],
  defaultAdapter: LLMAdapter,
  defaultModel: string
): Map<string, AgentRunner> {
  const runners = new Map<string, AgentRunner>();

  for (const def of agentDefs) {
    // If model looks like an adapter name (e.g. "claude-code"), use default
    const isAdapterName = def.model === "claude-code" || def.model === "anthropic" || def.model === "openai";
    const runner = new RoleAgentRunner(
      defaultAdapter,
      (isAdapterName ? null : def.model) ?? defaultModel,
      def.systemPrompt,
      def.name
    );
    runners.set(def.id, runner);
  }

  // Default runner = first agent or fallback
  if (!runners.has("default") && runners.size > 0) {
    runners.set("default", runners.values().next().value!);
  }

  return runners;
}
