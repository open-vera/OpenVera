import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MarkdownFlowInput, MarkdownFlowStepInput } from "./internal.js";

function parseFrontmatter(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw.trim() };

  const frontmatter: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2].trim();
    if (/^\d+$/.test(value)) {
      frontmatter[key] = Number(value);
    } else {
      frontmatter[key] = value.replace(/^["']|["']$/g, "");
    }
  }
  return { frontmatter, body: match[2].trim() };
}

function parseFlowSteps(body: string): MarkdownFlowStepInput[] {
  const steps: MarkdownFlowStepInput[] = [];
  const sections = body.split(/^## /m).filter(Boolean);

  for (const section of sections) {
    const lines = section.trim().split("\n");
    const heading = lines[0] ?? "";
    const headingMatch = heading.match(/^(\d+)\.\s+(.+?)\s*[→\->]+\s*(\S+)/);
    if (!headingMatch) continue;

    const agents: string[] = [];
    const inputs: string[] = [];
    for (const line of lines.slice(1)) {
      const trimmed = line.trim();
      const agentMatch = trimmed.match(/^-\s*参与[:：]\s*(.+)/);
      if (agentMatch)
        agents.push(
          ...agentMatch[1]
            .split(/[,，]/)
            .map((item) => item.trim())
            .filter(Boolean)
        );
      const inputMatch = trimmed.match(/^-\s*输入[:：]\s*(.+)/);
      if (inputMatch)
        inputs.push(
          ...inputMatch[1]
            .split(/[,，]/)
            .map((item) => item.trim())
            .filter(Boolean)
        );
    }

    steps.push({
      index: Number(headingMatch[1]),
      name: headingMatch[2].trim(),
      dir: headingMatch[3].replace(/\/$/, ""),
      agents,
      inputs,
    });
  }

  return steps;
}

export async function readMarkdownFlow(
  flowDir: string
): Promise<MarkdownFlowInput> {
  const raw = await readFile(join(flowDir, "flow.md"), "utf-8");
  const { frontmatter, body } = parseFrontmatter(raw);

  const ws = frontmatter.workspace;
  const workspaceRel =
    typeof ws === "string"
      ? ws
      : ws === undefined || ws === null
        ? "../"
        : typeof ws === "number" || typeof ws === "boolean"
          ? String(ws)
          : "../";

  return {
    workspaceRel,
    maxRetries: Number(frontmatter.max_retries ?? 3),
    steps: parseFlowSteps(body),
    rawFlowBody: body,
  };
}
