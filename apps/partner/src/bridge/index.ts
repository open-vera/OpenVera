/**
 * Thin adapters over Workbench Host (`host_dispatch`).
 * No direct Tauri command names besides host_boot / host_dispatch.
 */
import type {
  DirEntry,
  FileContentSearchEntry,
  FileSearchEntry,
  ShellOutput,
} from "@/types";
import { hostDispatch } from "@/shell";

interface RawDirEntry {
  name: string;
  isDir?: boolean;
  is_dir?: boolean;
}

interface RawFileSearchEntry extends RawDirEntry {
  path: string;
}

interface RawFileContentSearchEntry {
  name: string;
  path: string;
  line_number?: number;
  lineNumber?: number;
  line: string;
}

interface RawPathInfo {
  path: string;
  isDir?: boolean;
  is_dir?: boolean;
  isFile?: boolean;
  is_file?: boolean;
}

interface RawShellOutput {
  stdout: string;
  stderr: string;
  exitCode?: number;
  exit_code?: number;
}

export interface PathInfo {
  path: string;
  isDir: boolean;
  isFile: boolean;
}

function normalizeDirEntry(entry: RawDirEntry): DirEntry {
  return {
    name: entry.name,
    isDir: entry.isDir ?? entry.is_dir ?? false,
  };
}

export async function readFile(path: string): Promise<string> {
  return hostDispatch<string>({ op: "host.fs.read", path });
}

export async function writeFile(path: string, content: string): Promise<void> {
  await hostDispatch({ op: "host.fs.write", path, content });
}

export async function appendFile(path: string, content: string): Promise<void> {
  await hostDispatch({ op: "host.fs.append", path, content });
}

export async function pathInfo(path: string): Promise<PathInfo> {
  const info = await hostDispatch<RawPathInfo>({ op: "host.fs.path_info", path });
  return {
    path: info.path,
    isDir: info.isDir ?? info.is_dir ?? false,
    isFile: info.isFile ?? info.is_file ?? false,
  };
}

export async function listDir(path: string): Promise<DirEntry[]> {
  const entries = await hostDispatch<Array<RawDirEntry & { path?: string }>>({
    op: "host.workspace.list_dir",
    path,
  });
  return entries.map(normalizeDirEntry);
}

export async function createDir(path: string): Promise<void> {
  await hostDispatch({ op: "host.fs.create_dir", path });
}

export async function renamePath(from: string, to: string): Promise<void> {
  await hostDispatch({ op: "host.fs.rename", from, to });
}

export async function deletePath(path: string): Promise<void> {
  await hostDispatch({ op: "host.fs.delete", path });
}

export async function copyPath(from: string, to: string): Promise<void> {
  await hostDispatch({ op: "host.fs.copy", from, to });
}

export async function revealInOs(path: string): Promise<void> {
  await hostDispatch({ op: "host.fs.reveal", path });
}

export type RunLogSource = "global" | "legacy-project" | "missing";

export interface RunLogView {
  /** Resolved log file, or the directory logs will appear in when missing. */
  path: string;
  exists: boolean;
  content: string;
  truncated: boolean;
  totalBytes: number;
  source: RunLogSource;
}

/**
 * Resolve and read an agent run log. The host owns path resolution — the log
 * file is named after a task id under a UTC day directory, so Shell cannot
 * reliably guess it.
 */
export async function readRunLog(
  projectRoot: string,
  taskId?: string | null,
  maxBytes?: number,
): Promise<RunLogView> {
  return hostDispatch<RunLogView>({
    op: "host.run_log.read",
    projectRoot,
    taskId: taskId ?? null,
    maxBytes,
  });
}

export type StorageScope = "global" | "project";

export interface StorageEntry {
  /** Stable key the settings panel maps to a localized label. */
  id: string;
  path: string;
  scope: StorageScope;
  exists: boolean;
  isDir: boolean;
  bytes: number;
  files: number;
}

export interface StorageUsageReport {
  entries: StorageEntry[];
  totalBytes: number;
  totalFiles: number;
}

/** Read-only footprint scan; the host runs the walk on a blocking thread. */
export async function scanStorageUsage(
  projectRoot?: string | null,
): Promise<StorageUsageReport> {
  return hostDispatch<StorageUsageReport>({
    op: "host.storage.usage",
    projectRoot: projectRoot ?? null,
  });
}

export async function searchFiles(
  root: string,
  query: string,
  limit = 80,
  include?: string,
  exclude?: string,
): Promise<FileSearchEntry[]> {
  const entries = await hostDispatch<RawFileSearchEntry[]>({
    op: "host.fs.search_files",
    root,
    query,
    limit,
    include,
    exclude,
  });
  return entries.map((entry) => ({
    ...normalizeDirEntry(entry),
    path: entry.path,
  }));
}

export async function searchContent(
  root: string,
  query: string,
  limit = 80,
  include?: string,
  exclude?: string,
): Promise<FileContentSearchEntry[]> {
  const entries = await hostDispatch<RawFileContentSearchEntry[]>({
    op: "host.fs.search_content",
    root,
    query,
    limit,
    include,
    exclude,
  });
  return entries.map((entry) => ({
    name: entry.name,
    path: entry.path,
    lineNumber: entry.lineNumber ?? entry.line_number ?? 1,
    line: entry.line,
  }));
}

export async function replaceContent(
  root: string,
  query: string,
  replacement: string,
  include?: string,
  exclude?: string,
): Promise<number> {
  return hostDispatch<number>({
    op: "host.fs.replace_content",
    root,
    query,
    replacement,
    include,
    exclude,
  });
}

export async function executeShell(
  cmd: string,
  args: string[] = [],
  cwd?: string,
  timeoutMs?: number,
  confirmed = false,
): Promise<ShellOutput> {
  const output = await hostDispatch<RawShellOutput>({
    op: "host.shell.execute",
    cmd,
    args,
    cwd,
    timeoutMs,
    confirmed,
  });
  return {
    stdout: output.stdout,
    stderr: output.stderr,
    exitCode: output.exitCode ?? output.exit_code ?? -1,
  };
}

export async function storeSecret(
  service: string,
  key: string,
  value: string,
): Promise<void> {
  await hostDispatch({ op: "host.keychain.store", service, key, value });
}

export async function getSecret(
  service: string,
  key: string,
): Promise<string | null> {
  return hostDispatch<string | null>({ op: "host.keychain.get", service, key });
}

export async function deleteSecret(service: string, key: string): Promise<void> {
  await hostDispatch({ op: "host.keychain.delete", service, key });
}

export async function defaultServiceName(): Promise<string> {
  return hostDispatch<string>({ op: "host.keychain.default_service" });
}

export async function getAppVersion(): Promise<string> {
  return hostDispatch<string>({ op: "host.app.version" });
}

export {
  approveAgentTool,
  getSidecarInfo,
  getSidecarStatus,
  inspectLlmConfig,
  saveVeraLlmConfig,
  renameVeraProvider,
  saveVeraModelsRouting,
} from "./agent.js";
export { startLsp, stopLsp, lspSymbolSearch } from "./lsp.js";
