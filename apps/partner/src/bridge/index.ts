import { invoke } from "@tauri-apps/api/core";
import type {
  DirEntry,
  FileContentSearchEntry,
  FileSearchEntry,
  GitChange,
  ShellOutput,
} from "@/types";

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
  return invoke<string>("read_file", { path });
}

export async function writeFile(path: string, content: string): Promise<void> {
  return invoke<void>("write_file", { path, content });
}

export async function appendFile(path: string, content: string): Promise<void> {
  return invoke<void>("append_file", { path, content });
}

export async function pathInfo(path: string): Promise<PathInfo> {
  const info = await invoke<RawPathInfo>("path_info", { path });
  return {
    path: info.path,
    isDir: info.isDir ?? info.is_dir ?? false,
    isFile: info.isFile ?? info.is_file ?? false,
  };
}

export async function listDir(path: string): Promise<DirEntry[]> {
  const entries = await invoke<RawDirEntry[]>("list_dir", { path });
  return entries.map(normalizeDirEntry);
}

export async function searchFiles(
  root: string,
  query: string,
  limit = 80,
  include?: string,
  exclude?: string,
): Promise<FileSearchEntry[]> {
  const entries = await invoke<RawFileSearchEntry[]>("search_files", {
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
  const entries = await invoke<RawFileContentSearchEntry[]>("search_content", {
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
  return invoke<number>("replace_content", {
    root,
    query,
    replacement,
    include,
    exclude,
  });
}

export async function gitStatus(path: string): Promise<GitChange[]> {
  return invoke<GitChange[]>("git_status", { path });
}

export async function executeShell(
  cmd: string,
  args: string[] = [],
  cwd?: string,
  timeoutMs?: number,
  confirmed = false,
): Promise<ShellOutput> {
  const output = await invoke<RawShellOutput>("execute_shell", {
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
  return invoke<void>("store_secret", { service, key, value });
}

export async function getSecret(
  service: string,
  key: string,
): Promise<string | null> {
  return invoke<string | null>("get_secret", { service, key });
}

export async function deleteSecret(service: string, key: string): Promise<void> {
  return invoke<void>("delete_secret", { service, key });
}

export async function defaultServiceName(): Promise<string> {
  return invoke<string>("default_service_name");
}

export async function getAppVersion(): Promise<string> {
  return invoke<string>("get_app_version");
}

export {
  invokeAgentRun,
  waitForAgentCompletion,
  abortAgent,
  getSidecarStatus,
  inspectLlmConfig,
  saveVeraLlmConfig,
} from "./agent.js";
export { startLsp, stopLsp, lspSymbolSearch } from "./lsp.js";
export { loadPartnerSessions, savePartnerSessions } from "./storage.js";
