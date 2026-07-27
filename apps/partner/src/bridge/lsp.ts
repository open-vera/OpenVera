import type { PreviewLanguageId } from "@/preview/language";
import type { LspSymbolSearchEntry } from "@/types";
import { hostDispatch } from "@/shell";

export interface LspStartResult {
  wsUrl: string;
  languageId: string;
  serverId: string;
}

/** LSP goes through Workbench Host (`host.lsp.*`). */
export async function startLsp(
  languageId: PreviewLanguageId,
  workspaceRoot: string,
  _filePath: string,
): Promise<LspStartResult> {
  const data = await hostDispatch<Record<string, unknown>>({
    op: "host.lsp.start",
    languageId,
    workspaceRoot,
  });
  return {
    wsUrl: String(data.wsUrl ?? data.ws_url ?? ""),
    languageId: String(data.languageId ?? data.language_id ?? languageId),
    serverId: String(data.serverId ?? data.server_id ?? ""),
  };
}

export async function stopLsp(serverId: string): Promise<void> {
  await hostDispatch({
    op: "host.lsp.stop",
    languageId: serverId,
  });
}

export async function lspSymbolSearch(
  workspaceRoot: string,
  query: string,
  _limit = 80,
): Promise<LspSymbolSearchEntry[]> {
  const data = await hostDispatch<LspSymbolSearchEntry[] | { items?: LspSymbolSearchEntry[] }>({
    op: "host.lsp.symbol_search",
    workspaceRoot,
    query,
  });
  if (Array.isArray(data)) return data;
  return data.items ?? [];
}
