import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  FlowAgentDefinition,
  FlowDefinition,
  FlowStageRef,
  StageDefinition,
} from "./types.js";

interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(",")
      .map((item) => item.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  return trimmed.replace(/^["']|["']$/g, "");
}

export function parseFrontmatter(raw: string): ParsedMarkdown {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw.trim() };

  const frontmatter: Record<string, unknown> = {};
  for (const line of match[1]!.split("\n")) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
    if (!kv) continue;
    frontmatter[kv[1]!] = parseScalar(kv[2]!);
  }
  return { frontmatter, body: match[2]!.trim() };
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function parseInlineList(value: string): string[] {
  const parsed = parseScalar(value);
  return asStringArray(parsed);
}

function parseStageRefs(body: string): FlowStageRef[] {
  const stagesMatch = body.match(/(?:^|\n)##\s+Stages\s*\n([\s\S]*?)(?=\n##\s+|\n#\s+|$)/);
  const source = stagesMatch?.[1] ?? body;
  const refs: FlowStageRef[] = [];
  let current: Partial<FlowStageRef> | undefined;

  for (const rawLine of source.split("\n")) {
    const line = rawLine.trimEnd();
    const item = line.match(/^-\s+id:\s*(.+)$/);
    if (item) {
      if (current?.id) refs.push(normalizeStageRef(current));
      current = { id: item[1]!.trim(), agents: [], dependsOn: [] };
      continue;
    }

    if (!current) continue;
    const kv = line.match(/^\s+([A-Za-z0-9_-]+):\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1]!;
    const value = kv[2]!.trim();
    if (key === "stage") current.stage = value;
    if (key === "agents") current.agents = parseInlineList(value);
    if (key === "depends_on" || key === "dependsOn") {
      current.dependsOn = parseInlineList(value);
    }
  }

  if (current?.id) refs.push(normalizeStageRef(current));
  return refs;
}

function normalizeStageRef(input: Partial<FlowStageRef>): FlowStageRef {
  const id = input.id ?? "";
  return {
    id,
    stage: input.stage ?? id,
    agents: input.agents ?? [],
    dependsOn: input.dependsOn ?? [],
  };
}

function extractGoal(body: string): string {
  const match = body.match(/(?:^|\n)#\s+(?:Goal|目标)\s*\n([\s\S]*?)(?=\n#|$)/);
  const first = match?.[1]?.split("\n").find((line) => line.trim());
  return first?.trim() ?? "Execute flow";
}

function extractExitCriteria(body: string): string | undefined {
  const match = body.match(/(?:^|\n)##\s+(?:Exit Criteria|准出标准)\s*\n([\s\S]*?)(?=\n##\s+|\n#\s+|$)/);
  return match?.[1]?.trim();
}

async function loadStageDefinitions(flowsDir: string): Promise<Map<string, StageDefinition>> {
  const stagesDir = join(flowsDir, "stages");
  const definitions = new Map<string, StageDefinition>();
  if (!existsSync(stagesDir)) return definitions;

  for (const entry of await readdir(stagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const mainPath = join(stagesDir, entry.name, "main.md");
    if (!existsSync(mainPath)) continue;
    const { frontmatter, body } = parseFrontmatter(await readFile(mainPath, "utf-8"));
    definitions.set(entry.name, {
      id: entry.name,
      name: asString(frontmatter.name, entry.name),
      agents: asStringArray(frontmatter.agents),
      body,
      exitCriteria: extractExitCriteria(body),
    });
  }
  return definitions;
}

export async function loadFlowAgents(flowsDir: string): Promise<FlowAgentDefinition[]> {
  const agentsDir = join(flowsDir, "agents");
  if (!existsSync(agentsDir)) return [];

  const agents: FlowAgentDefinition[] = [];
  for (const entry of await readdir(agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const mainPath = join(agentsDir, entry.name, "main.md");
    if (!existsSync(mainPath)) continue;
    const { frontmatter, body } = parseFrontmatter(await readFile(mainPath, "utf-8"));
    agents.push({
      id: entry.name,
      name: asString(frontmatter.name, entry.name),
      model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
      adapter: typeof frontmatter.adapter === "string" ? frontmatter.adapter : undefined,
      skills: asStringArray(frontmatter.skills),
      rules: asStringArray(frontmatter.rules),
      mcp: asStringArray(frontmatter.mcp),
      systemPrompt: body,
    });
  }
  return agents;
}

export async function listFlowDefinitions(flowsDir: string): Promise<string[]> {
  const flowRoot = join(flowsDir, "flow");
  if (!existsSync(flowRoot)) return [];

  const names: string[] = [];
  for (const entry of await readdir(flowRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const mainPath = join(flowRoot, entry.name, "main.md");
    if (existsSync(mainPath)) names.push(entry.name);
  }
  return names.sort();
}

async function resolveFlowMainPath(
  flowsDir: string,
  flowName?: string
): Promise<{ id: string; mainPath: string }> {
  const names = await listFlowDefinitions(flowsDir);
  if (flowName) {
    const mainPath = join(flowsDir, "flow", flowName, "main.md");
    if (!existsSync(mainPath)) {
      throw new Error(`No flow definition found at ${mainPath}`);
    }
    return { id: flowName, mainPath };
  }
  if (names.length === 1) {
    const id = names[0]!;
    return { id, mainPath: join(flowsDir, "flow", id, "main.md") };
  }
  if (names.length > 1) {
    throw new Error(
      `Multiple flows found: ${names.join(", ")}. Specify one with openvera run <name>.`
    );
  }
  throw new Error(`No flow definitions found under ${join(flowsDir, "flow", "<name>", "main.md")}`);
}

export async function loadFlowDefinition(
  flowsDir: string,
  flowName?: string
): Promise<FlowDefinition> {
  const { id, mainPath } = await resolveFlowMainPath(flowsDir, flowName);
  if (!existsSync(mainPath)) {
    throw new Error(`No flow definition found at ${mainPath}`);
  }

  const { frontmatter, body } = parseFrontmatter(await readFile(mainPath, "utf-8"));
  const name = asString(frontmatter.name, id);
  const stageDefinitions = await loadStageDefinitions(flowsDir);

  return {
    id,
    name,
    filePath: mainPath,
    workspaceRel: asString(frontmatter.workspace, "../.."),
    maxRetries: asNumber(frontmatter.max_retries, 3),
    maxParallel: asNumber(frontmatter.max_parallel, 3),
    goal: extractGoal(body),
    rawBody: body,
    stages: parseStageRefs(body),
    stageDefinitions,
    agents: await loadFlowAgents(flowsDir),
  };
}
