import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { LLMAdapter } from "@open-vera/core/adapters";
import type { AgentRunner } from "../agent/types.js";
import { RoleAgentRunner } from "../agent/role-runners.js";

export interface AgentDefinition {
  id: string;
  name: string;
  model?: string;
  adapter?: string;
  systemPrompt: string;
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw.trim() };

  const frontmatter: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
    if (kv) frontmatter[kv[1]!] = kv[2]!.trim().replace(/^["']|["']$/g, "");
  }
  return { frontmatter, body: match[2]!.trim() };
}

export async function loadAgents(flowDir: string): Promise<AgentDefinition[]> {
  const agentsDir = join(flowDir, "agents");
  if (!existsSync(agentsDir)) return [];

  const entries = await readdir(agentsDir, { withFileTypes: true });
  const agents: AgentDefinition[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const mainPath = join(agentsDir, entry.name, "main.md");
    if (!existsSync(mainPath)) continue;

    const raw = await readFile(mainPath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(raw);

    agents.push({
      id: entry.name,
      name: frontmatter.name ?? entry.name,
      model: frontmatter.model,
      adapter: frontmatter.adapter,
      systemPrompt: body,
    });
  }

  return agents;
}

/**
 * Create AgentRunnerMap from agent definitions loaded from .flow/agents/*.
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
