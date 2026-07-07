import { invoke } from "@tauri-apps/api/core";
import type { PreviewLanguageId } from "@/preview/language";
import type { LspSymbolSearchEntry } from "@/types";

export interface LspStartResult {
  wsUrl: string;
  languageId: string;
  serverId: string;
}

export async function startLsp(
  languageId: PreviewLanguageId,
  workspaceRoot: string,
  filePath: string,
): Promise<LspStartResult> {
  return invoke<LspStartResult>("lsp_start", {
    languageId,
    workspaceRoot,
    filePath,
  });
}

export async function stopLsp(serverId: string): Promise<void> {
  await invoke("lsp_stop", { serverId });
}

export async function lspSymbolSearch(
  workspaceRoot: string,
  query: string,
  limit = 80,
): Promise<LspSymbolSearchEntry[]> {
  return invoke<LspSymbolSearchEntry[]>("lsp_symbol_search", {
    workspaceRoot,
    query,
    limit,
  });
}
