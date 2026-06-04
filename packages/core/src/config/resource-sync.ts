import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { globalDataPath, globalVeraDir } from "./paths.js";

export type ResourceSyncStatus = "created" | "skipped" | "conflict" | "missing";

export interface ResourceSyncEntry {
  source: string;
  target: string;
  status: ResourceSyncStatus;
  kind: "context" | "skill" | "memory" | "raw";
}

export interface ResourceSyncOptions {
  force?: boolean;
}

interface ExternalSource {
  id: "claude" | "codex" | "openclaw" | "hermes";
  root: string;
}

export function syncExternalResources(options: ResourceSyncOptions = {}): ResourceSyncEntry[] {
  const entries: ResourceSyncEntry[] = [];
  const veraDir = globalVeraDir();
  const importsDir = join(veraDir, "imports");
  const rulesDir = join(veraDir, "rules");
  const skillsDir = join(veraDir, "skills");
  const memoryDir = globalDataPath("memory");

  for (const source of externalSources()) {
    if (!existsSync(source.root)) continue;
    const sourceImportDir = join(importsDir, source.id);
    mkdirSync(sourceImportDir, { recursive: true });

    entries.push(...syncRawImports(source, sourceImportDir, options));
    entries.push(...syncContextFiles(source, rulesDir, options));
    entries.push(...syncSkillFiles(source, skillsDir, options));
    entries.push(...syncMemoryDir(source, memoryDir, options));
  }

  return entries;
}

function externalSources(): ExternalSource[] {
  const claudeRoot = process.env.CLAUDE_CONFIG_DIR
    ? resolve(process.env.CLAUDE_CONFIG_DIR)
    : join(homedir(), ".claude");
  return [
    { id: "claude", root: claudeRoot },
    { id: "codex", root: resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex")) },
    { id: "openclaw", root: resolve(process.env.OPENCLAW_HOME ?? join(homedir(), ".openclaw")) },
    { id: "hermes", root: resolve(process.env.HERMES_HOME ?? join(homedir(), ".hermes")) },
  ];
}

function syncRawImports(
  source: ExternalSource,
  importsDir: string,
  options: ResourceSyncOptions,
): ResourceSyncEntry[] {
  const entries: ResourceSyncEntry[] = [];
  for (const name of ["commands", "rules", "skills", "memories", "CLAUDE.md", "AGENTS.md", "SOUL.md"]) {
    const sourcePath = join(source.root, name);
    if (!existsSync(sourcePath)) continue;
    entries.push(link(sourcePath, join(importsDir, name), "raw", options));
  }
  return entries;
}

function syncContextFiles(
  source: ExternalSource,
  rulesDir: string,
  options: ResourceSyncOptions,
): ResourceSyncEntry[] {
  const entries: ResourceSyncEntry[] = [];
  for (const name of ["CLAUDE.md", "AGENTS.md", "SOUL.md", "memory.md", "MEMORY.md"]) {
    const sourcePath = join(source.root, name);
    if (!existsSync(sourcePath)) continue;
    entries.push(link(sourcePath, join(rulesDir, `${source.id}-${name}`), "context", options));
  }

  const rulesPath = join(source.root, "rules");
  if (existsSync(rulesPath)) {
    for (const file of safeReadDir(rulesPath)) {
      if (!isMarkdownLike(file)) continue;
      entries.push(link(
        join(rulesPath, file),
        join(rulesDir, `${source.id}-${file}`),
        "context",
        options,
      ));
    }
  }
  return entries;
}

function syncSkillFiles(
  source: ExternalSource,
  skillsDir: string,
  options: ResourceSyncOptions,
): ResourceSyncEntry[] {
  const root = join(source.root, "skills");
  if (!existsSync(root)) return [];

  const entries: ResourceSyncEntry[] = [];
  for (const entry of safeReadDir(root)) {
    const entryPath = join(root, entry);
    if (isDirectory(entryPath)) {
      const skillPath = join(entryPath, "SKILL.md");
      if (existsSync(skillPath)) {
        entries.push(link(skillPath, join(skillsDir, `${source.id}-${entry}.md`), "skill", options));
      }
      continue;
    }
    if (extname(entry) === ".md") {
      entries.push(link(entryPath, join(skillsDir, `${source.id}-${entry}`), "skill", options));
    }
  }
  return entries;
}

function syncMemoryDir(
  source: ExternalSource,
  memoryDir: string,
  options: ResourceSyncOptions,
): ResourceSyncEntry[] {
  const sourceDir = firstExisting(join(source.root, "memories"), join(source.root, "memory"));
  if (!sourceDir) return [];
  return [link(sourceDir, join(memoryDir, source.id), "memory", options)];
}

function link(
  source: string,
  target: string,
  kind: ResourceSyncEntry["kind"],
  options: ResourceSyncOptions,
): ResourceSyncEntry {
  const resolvedSource = resolve(source);
  const resolvedTarget = resolve(target);
  if (!existsSync(resolvedSource)) {
    return { source: resolvedSource, target: resolvedTarget, kind, status: "missing" };
  }

  mkdirSync(dirname(resolvedTarget), { recursive: true });
  if (existsSync(resolvedTarget)) {
    const stat = lstatSync(resolvedTarget);
    if (stat.isSymbolicLink()) {
      const current = resolve(dirname(resolvedTarget), readlinkSync(resolvedTarget));
      if (current === resolvedSource) {
        return { source: resolvedSource, target: resolvedTarget, kind, status: "skipped" };
      }
      if (options.force) {
        unlinkSync(resolvedTarget);
      } else {
        return { source: resolvedSource, target: resolvedTarget, kind, status: "conflict" };
      }
    } else {
      return { source: resolvedSource, target: resolvedTarget, kind, status: "conflict" };
    }
  }

  symlinkSync(resolvedSource, resolvedTarget, isDirectory(resolvedSource) ? "dir" : "file");
  return { source: resolvedSource, target: resolvedTarget, kind, status: "created" };
}

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isMarkdownLike(path: string): boolean {
  return [".md", ".txt"].includes(extname(path).toLowerCase());
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function firstExisting(...paths: string[]): string | undefined {
  return paths.find((path) => existsSync(path));
}
