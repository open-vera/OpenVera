import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export type VeraContextFileType = "user" | "project" | "local" | "rule";

export interface VeraContextFile {
  path: string;
  type: VeraContextFileType;
  content: string;
  parent?: string;
  globs?: string[];
  priority?: number;
}

export interface ProjectContext {
  files: VeraContextFile[];
  gitStatus?: string;
  system: string;
  signature: string;
}

export interface ProjectContextOptions {
  cwd: string;
  includeUser?: boolean;
  includeGitStatus?: boolean;
}

export interface NestedProjectContextOptions {
  cwd: string;
  targetPath: string;
  loadedPaths?: Set<string>;
}

const MAX_INCLUDE_DEPTH = 5;
const MAX_FILE_CHARS = 40_000;
const MAX_GIT_STATUS_CHARS = 2_000;
const fileCache = new Map<string, { mtimeMs: number; files: VeraContextFile[] }>();

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".text",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".csv",
  ".html",
  ".css",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".c",
  ".cpp",
  ".h",
  ".cs",
  ".php",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".graphql",
  ".proto",
  ".vue",
  ".svelte",
  ".diff",
  ".patch",
  ".log",
]);

function isTextPath(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return ext === "" || TEXT_EXTENSIONS.has(ext);
}

function ancestorDirs(cwd: string): string[] {
  const dirs: string[] = [];
  let current = resolve(cwd);
  while (true) {
    dirs.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs.reverse();
}

function dirsFromCwdToTarget(cwd: string, targetPath: string): string[] {
  const root = resolve(cwd);
  const target = resolve(root, targetPath);
  const targetDir = statMaybe(target)?.isDirectory() ? target : dirname(target);

  const rel = relative(root, targetDir);
  if (rel.startsWith("..") || isAbsolute(rel)) return [];
  const parts = rel ? rel.split(sep).filter(Boolean) : [];

  const dirs = [root];
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    dirs.push(current);
  }
  return dirs;
}

function statMaybe(path: string) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function parseFrontmatter(raw: string): { content: string; globs?: string[]; priority?: number } {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") return { content: raw };

  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end === -1) return { content: raw };

  const fields = lines.slice(1, end);
  const body = lines.slice(end + 1).join("\n");
  const pathLine = fields.find((line) => line.trim().startsWith("paths:"));
  const priorityLine = fields.find((line) => line.trim().startsWith("priority:"));
  const priorityRaw = priorityLine?.slice(priorityLine.indexOf(":") + 1).trim();
  const parsedPriority = priorityRaw ? Number(priorityRaw) : undefined;
  const priority = parsedPriority !== undefined && Number.isFinite(parsedPriority)
    ? parsedPriority
    : undefined;
  if (!pathLine) return { content: body, ...(priority !== undefined ? { priority } : {}) };

  const rawPaths = pathLine.slice(pathLine.indexOf(":") + 1).trim();
  const globs = rawPaths
    .split(/[,\s]+/)
    .map((p) => p.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
    .filter((p) => p !== "**");

  return {
    content: body,
    ...(globs.length > 0 ? { globs } : {}),
    ...(priority !== undefined ? { priority } : {}),
  };
}

function globToRegex(pattern: string): RegExp {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*" && pattern[i + 1] === "*" && pattern[i + 2] === "/") {
      re += "(?:.*/)?";
      i += 2;
    } else if (c === "*" && pattern[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`${re}$`);
}

function matchesGlobs(filePath: string, baseDir: string, globs?: string[]): boolean {
  if (!globs || globs.length === 0) return true;
  const rel = relative(baseDir, filePath).replaceAll("\\", "/");
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
  return globs.some((glob) => globToRegex(glob).test(rel));
}

function resolveInclude(includePath: string, baseFile: string): string | null {
  const cleaned = includePath.replace(/\\ /g, " ").split("#")[0]?.trim();
  if (!cleaned) return null;
  if (cleaned.startsWith("~/")) return join(homedir(), cleaned.slice(2));
  if (isAbsolute(cleaned)) return cleaned;
  return resolve(dirname(baseFile), cleaned.startsWith("./") ? cleaned : `./${cleaned}`);
}

function extractIncludes(content: string): string[] {
  const includes: string[] = [];
  const re = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const path = match[1]?.trim();
    if (path && /^[A-Za-z0-9._~/-]/.test(path)) includes.push(path);
  }
  return includes;
}

function readVeraFile(
  filePath: string,
  type: VeraContextFileType,
  processed: Set<string>,
  depth = 0,
  parent?: string,
): VeraContextFile[] {
  const resolved = resolve(filePath);
  if (processed.has(resolved) || depth >= MAX_INCLUDE_DEPTH || !isTextPath(resolved)) {
    return [];
  }
  processed.add(resolved);

  const stat = statMaybe(resolved);
  if (!stat) return [];
  const cached = fileCache.get(resolved);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.files.map((file) => ({
      ...file,
      ...(parent ? { parent } : file.parent ? { parent: file.parent } : {}),
    }));
  }

  let raw: string;
  try {
    raw = readFileSync(resolved, "utf8");
  } catch {
    return [];
  }

  const { content, globs, priority } = parseFrontmatter(raw);
  const trimmed = content.trim();
  if (!trimmed) return [];

  const clipped =
    trimmed.length > MAX_FILE_CHARS
      ? `${trimmed.slice(0, MAX_FILE_CHARS)}\n[truncated]`
      : trimmed;

  const file: VeraContextFile = { path: resolved, type, content: clipped };
  if (parent) file.parent = parent;
  if (globs) file.globs = globs;
  if (priority !== undefined) file.priority = priority;

  const result = [file];
  for (const includePath of extractIncludes(content)) {
    const include = resolveInclude(includePath, resolved);
    if (!include) continue;
    result.push(...readVeraFile(include, type, processed, depth + 1, resolved));
  }
  fileCache.set(resolved, { mtimeMs: stat.mtimeMs, files: result });
  return result;
}

function readRulesDir(
  rulesDir: string,
  type: VeraContextFileType,
  processed: Set<string>,
  targetPath?: string,
  baseDir?: string,
): VeraContextFile[] {
  if (!existsSync(rulesDir)) return [];
  const files: string[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const stat = statMaybe(path);
      if (!stat) continue;
      if (stat.isDirectory()) walk(path);
      else if (entry.endsWith(".md")) files.push(path);
    }
  }

  walk(rulesDir);
  return files
    .sort()
    .flatMap((path) => {
      const loaded = readVeraFile(path, type, processed);
      const main = loaded.find((file) => file.path === resolve(path));
      if (!main) return [];
      const applies =
        targetPath && baseDir
          ? matchesGlobs(resolve(baseDir, targetPath), baseDir, main.globs)
          : !main.globs || main.globs.length === 0;
      return applies ? loaded : [];
    });
}

function getGitStatus(cwd: string): string | undefined {
  try {
    const branch = execFileSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8" }).trim();
    const status = execFileSync("git", ["--no-optional-locks", "status", "--short"], { cwd, encoding: "utf8" }).trim();
    const log = execFileSync("git", ["--no-optional-locks", "log", "--oneline", "-n", "5"], { cwd, encoding: "utf8" }).trim();
    const clippedStatus =
      status.length > MAX_GIT_STATUS_CHARS
        ? `${status.slice(0, MAX_GIT_STATUS_CHARS)}\n... (truncated)`
        : status || "(clean)";
    return [
      "Git status snapshot at conversation start.",
      `Current branch: ${branch || "(unknown)"}`,
      `Status:\n${clippedStatus}`,
      `Recent commits:\n${log || "(none)"}`,
    ].join("\n\n");
  } catch {
    return undefined;
  }
}

function formatVeraContext(files: VeraContextFile[], gitStatus?: string): string {
  const parts: string[] = [];
  if (gitStatus) {
    parts.push(`<vera-git-status>\n${gitStatus}\n</vera-git-status>`);
  }
  if (files.length > 0) {
    parts.push(
      [
        "Vera project and user instructions are shown below. Follow them when working in this repository.",
        ...files.map((file) => {
          const note =
            file.type === "project"
              ? "project instructions"
              : file.type === "local"
                ? "private local instructions"
                : file.type === "rule"
                  ? "project rule"
                  : "private user instructions";
          const globs = file.globs ? `\nApplies to: ${file.globs.join(", ")}` : "";
          const priority = file.priority !== undefined ? `\nPriority: ${file.priority}` : "";
          return `Contents of ${file.path} (${note})${globs}${priority}:\n\n${file.content}`;
        }),
      ].join("\n\n"),
    );
  }
  return parts.join("\n\n");
}

function signatureFor(files: VeraContextFile[], gitStatus?: string): string {
  return [
    gitStatus ?? "",
    ...files.map((file) => `${file.path}:${file.type}:${file.priority ?? 0}:${file.content.length}`),
  ].join("|");
}

function sortContextFiles(files: VeraContextFile[]): VeraContextFile[] {
  return [...files].sort((a, b) => {
    const priority = (a.priority ?? 0) - (b.priority ?? 0);
    if (priority !== 0) return priority;
    return a.path.localeCompare(b.path);
  });
}

export function loadProjectContext(options: ProjectContextOptions): ProjectContext {
  const cwd = resolve(options.cwd);
  const processed = new Set<string>();
  const files: VeraContextFile[] = [];

  if (options.includeUser !== false) {
    files.push(...readVeraFile(join(homedir(), ".vera", "VERA.md"), "user", processed));
    files.push(...readRulesDir(join(homedir(), ".vera", "rules"), "user", processed));
  }

  for (const dir of ancestorDirs(cwd)) {
    files.push(...readVeraFile(join(dir, "VERA.md"), "project", processed));
    files.push(...readVeraFile(join(dir, ".vera", "VERA.md"), "project", processed));
    files.push(...readRulesDir(join(dir, ".vera", "rules"), "rule", processed));
    files.push(...readVeraFile(join(dir, "VERA.local.md"), "local", processed));
  }

  const gitStatus = options.includeGitStatus === false ? undefined : getGitStatus(cwd);
  const sortedFiles = sortContextFiles(files);
  return {
    files: sortedFiles,
    gitStatus,
    system: formatVeraContext(sortedFiles, gitStatus),
    signature: signatureFor(sortedFiles, gitStatus),
  };
}

export function loadNestedProjectContext(options: NestedProjectContextOptions): ProjectContext {
  const cwd = resolve(options.cwd);
  const processed = new Set(options.loadedPaths ?? []);
  const files: VeraContextFile[] = [];

  for (const dir of dirsFromCwdToTarget(cwd, options.targetPath)) {
    files.push(...readVeraFile(join(dir, "VERA.md"), "project", processed));
    files.push(...readVeraFile(join(dir, ".vera", "VERA.md"), "project", processed));
    files.push(...readVeraFile(join(dir, "VERA.local.md"), "local", processed));
    files.push(
      ...readRulesDir(
        join(dir, ".vera", "rules"),
        "rule",
        processed,
        resolve(cwd, options.targetPath),
        dir,
      ),
    );
  }

  const sortedFiles = sortContextFiles(files);
  return {
    files: sortedFiles,
    system: formatVeraContext(sortedFiles),
    signature: signatureFor(sortedFiles),
  };
}
