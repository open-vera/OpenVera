// Skill Loader — 从 .md 文件编译成 Skill 对象
//
// 文件格式：
//   ---
//   id: github
//   name: GitHub 操作
//   description: 管理 PR、issues
//   triggers:
//     - always
//     - domain: code
//     - level: 2
//     - needs_tools: true
//   tools:
//     - read_file
//     - bash
//   ---
//
//   （body 作为 systemFragment 注入）

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import type { Skill, SkillTrigger, IntentDomain } from "./types.js";
import type { ToolExecutor } from "./types.js";
import type { Tool } from "@vera/core/types";

export interface BuiltinToolProvider {
  /** Return Tool schema + executor for a built-in tool name, or null if unknown */
  resolve(name: string): { definition: Tool; executor: ToolExecutor } | null;
}

// ── Frontmatter parser (no external deps) ────────────────────────────────────

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const fence = "---";
  if (!raw.startsWith(fence)) return { meta: {}, body: raw };

  const end = raw.indexOf("\n---", fence.length);
  if (end === -1) return { meta: {}, body: raw };

  const yamlBlock = raw.slice(fence.length, end).trim();
  const body = raw.slice(end + 4).trim();

  return { meta: parseSimpleYaml(yamlBlock), body };
}

/**
 * Minimal YAML parser — supports the subset used in skill files:
 * - key: scalar
 * - key:
 *     - item
 *     - key2: value
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) { i++; continue; }

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) { i++; continue; }

    const key = trimmed.slice(0, colonIdx).trim();
    const rest = trimmed.slice(colonIdx + 1).trim();

    if (rest) {
      // Inline scalar: key: value
      result[key] = parseScalar(rest);
      i++;
    } else {
      // Block list/map follows
      const items: unknown[] = [];
      i++;
      while (i < lines.length) {
        const child = lines[i]!;
        if (!child.trim() || (!child.startsWith(" ") && !child.startsWith("\t"))) break;
        const childTrimmed = child.trim();
        if (childTrimmed.startsWith("- ")) {
          const item = childTrimmed.slice(2).trim();
          const childColon = item.indexOf(":");
          if (childColon !== -1) {
            // - key: value  (map item)
            const k = item.slice(0, childColon).trim();
            const v = item.slice(childColon + 1).trim();
            items.push({ [k]: parseScalar(v) });
          } else {
            items.push(parseScalar(item));
          }
        }
        i++;
      }
      result[key] = items;
    }
  }

  return result;
}

function parseScalar(s: string): unknown {
  if (s === "true") return true;
  if (s === "false") return false;
  const n = Number(s);
  if (!isNaN(n) && s !== "") return n;
  return s;
}

// ── Trigger parsing ───────────────────────────────────────────────────────────

function parseTriggers(raw: unknown): SkillTrigger[] {
  if (!Array.isArray(raw)) return [{ type: "explicit" }];

  const triggers: SkillTrigger[] = [];
  for (const item of raw) {
    if (item === "always") {
      triggers.push({ type: "always" });
    } else if (typeof item === "object" && item !== null) {
      const obj = item as Record<string, unknown>;
      if ("domain" in obj) {
        const d = obj.domain;
        const domains = Array.isArray(d) ? (d as IntentDomain[]) : [d as IntentDomain];
        triggers.push({ type: "domain", domains });
      } else if ("level" in obj) {
        triggers.push({ type: "level", minLevel: obj.level as 0 | 1 | 2 | 3 });
      } else if ("needs_tools" in obj && obj.needs_tools === true) {
        triggers.push({ type: "needs_tools" });
      }
    }
  }

  return triggers.length > 0 ? triggers : [{ type: "explicit" }];
}

// ── Skill file loader ─────────────────────────────────────────────────────────

export function loadSkillFile(
  filePath: string,
  toolProvider?: BuiltinToolProvider
): Skill {
  const raw = readFileSync(filePath, "utf8");
  const { meta, body } = parseFrontmatter(raw);

  const id = String(meta.id ?? filePath);
  const name = String(meta.name ?? id);
  const description = String(meta.description ?? "");
  const triggers = parseTriggers(meta.triggers);

  // Resolve built-in tool references
  const skillTools: Skill["tools"] = [];
  if (Array.isArray(meta.tools) && toolProvider) {
    for (const toolId of meta.tools as string[]) {
      const resolved = toolProvider.resolve(String(toolId));
      if (resolved) skillTools.push(resolved);
    }
  }

  // Build rules fragment from frontmatter rules[] + body
  const fragments: string[] = [];
  if (Array.isArray(meta.rules) && meta.rules.length > 0) {
    fragments.push((meta.rules as string[]).map((r) => `- ${r}`).join("\n"));
  }
  if (body) fragments.push(body);

  return {
    id,
    name,
    description,
    triggers,
    systemFragment: fragments.length > 0 ? fragments.join("\n\n") : undefined,
    tools: skillTools.length > 0 ? skillTools : undefined,
  };
}

/**
 * Load all .md files in a directory as skills.
 */
export function loadSkillDir(
  dir: string,
  toolProvider?: BuiltinToolProvider
): Skill[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  return entries
    .filter((f) => extname(f) === ".md")
    .map((f) => {
      try {
        return loadSkillFile(join(dir, f), toolProvider);
      } catch {
        return null;
      }
    })
    .filter((s): s is Skill => s !== null);
}
