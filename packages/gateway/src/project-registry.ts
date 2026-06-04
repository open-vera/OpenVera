import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { GatewayProject, ProjectRegistryOptions } from "@open-vera/shared";

export class ProjectRegistry {
  constructor(private readonly options: ProjectRegistryOptions) {}

  discover(): GatewayProject[] {
    const candidates = new Map<string, "explicit" | "discovered">();

    for (const root of this.options.roots) {
      const resolved = resolve(root);
      candidates.set(resolved, "explicit");

      if (this.options.includeChildren === false || !existsSync(resolved)) {
        continue;
      }

      for (const child of safeReadDir(resolved)) {
        const childPath = join(resolved, child);
        if (isDirectory(childPath) && looksLikeProject(childPath)) {
          candidates.set(childPath, "discovered");
        }
      }
    }

    return Array.from(candidates.entries())
      .filter(([rootDir]) => looksLikeProject(rootDir))
      .map(([rootDir, source]) => createProject(rootDir, source))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

export function createProject(rootDir: string, source: GatewayProject["source"] = "explicit"): GatewayProject {
  const resolved = resolve(rootDir);
  return {
    id: createProjectId(resolved),
    name: basename(resolved),
    rootDir: resolved,
    veraDir: join(resolved, ".vera"),
    flowsDir: join(resolved, ".vera", "flows"),
    source,
  };
}

export function looksLikeProject(rootDir: string): boolean {
  return existsSync(join(rootDir, ".vera")) || existsSync(join(rootDir, "package.json"));
}

function createProjectId(rootDir: string): string {
  const name = basename(rootDir).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const hash = createHash("sha1").update(rootDir).digest("hex").slice(0, 8);
  return `${name}-${hash}`;
}

function safeReadDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
