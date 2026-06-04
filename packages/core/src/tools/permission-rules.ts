import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globalVeraDir, projectResourcePath } from "../config/paths.js";

export interface PermissionRules {
  allowedTools?: string[];
  deniedTools?: string[];
  allowedBashCommands?: string[];
  deniedBashCommands?: string[];
}

function readRulesFile(path: string): PermissionRules {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as PermissionRules;
    return {
      allowedTools: stringArray(raw.allowedTools),
      deniedTools: stringArray(raw.deniedTools),
      allowedBashCommands: stringArray(raw.allowedBashCommands),
      deniedBashCommands: stringArray(raw.deniedBashCommands),
    };
  } catch {
    return {};
  }
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function mergeRules(a: PermissionRules, b: PermissionRules): PermissionRules {
  return {
    allowedTools: mergeArray(a.allowedTools, b.allowedTools),
    deniedTools: mergeArray(a.deniedTools, b.deniedTools),
    allowedBashCommands: mergeArray(a.allowedBashCommands, b.allowedBashCommands),
    deniedBashCommands: mergeArray(a.deniedBashCommands, b.deniedBashCommands),
  };
}

function mergeArray(a?: string[], b?: string[]): string[] | undefined {
  const merged = [...(a ?? []), ...(b ?? [])];
  return merged.length > 0 ? [...new Set(merged)] : undefined;
}

export function loadPermissionRules(cwd: string): PermissionRules {
  return mergeRules(
    readRulesFile(join(globalVeraDir(), "permissions.json")),
    readRulesFile(projectResourcePath(cwd, "permissions.json")),
  );
}

export function matchesPattern(value: string, patterns?: string[]): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((pattern) => globLikeToRegex(pattern).test(value));
}

function globLikeToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}
