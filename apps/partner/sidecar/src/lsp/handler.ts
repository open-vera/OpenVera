import { randomUUID } from "node:crypto";
import { resolveServer, type ActiveProxy } from "./config.js";
import { startLspProxy } from "./proxy.js";

const active = new Map<string, ActiveProxy>();

export async function handleLspStart(params: {
  languageId: string;
  workspaceRoot: string;
}): Promise<{ serverId: string; wsUrl: string; languageId: string }> {
  const spec = resolveServer(params.languageId);
  if (!spec) {
    throw new Error(`unsupported LSP language: ${params.languageId}`);
  }

  for (const [id, proxy] of active) {
    if (proxy.languageId === spec.languageId) {
      return {
        serverId: id,
        wsUrl: proxy.wsUrl,
        languageId: proxy.languageId,
      };
    }
  }

  const { port, child, close } = await startLspProxy(spec, params.workspaceRoot);
  const serverId = randomUUID();
  const wsUrl = `ws://127.0.0.1:${port}`;

  active.set(serverId, {
    id: serverId,
    languageId: spec.languageId,
    wsUrl,
    port,
    child,
    close,
  });

  return { serverId, wsUrl, languageId: spec.languageId };
}

export function handleLspStop(params: { serverId: string }): void {
  const proxy = active.get(params.serverId);
  if (!proxy) return;
  proxy.close();
  active.delete(params.serverId);
}