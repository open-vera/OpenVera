import { randomUUID } from "node:crypto";
import {
  listLspServers,
  resolveServer,
  type ActiveProxy,
  type LspServerSpec,
} from "./config.js";
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

  const { port, child, close } = await startLspProxy(
    spec,
    params.workspaceRoot
  );
  const serverId = randomUUID();
  const wsUrl = `ws://127.0.0.1:${port}`;

  active.set(serverId, {
    id: serverId,
    languageId: spec.languageId,
    wsUrl,
    port,
    child,
    close,
    startedAt: Date.now(),
  });

  return { serverId, wsUrl, languageId: spec.languageId };
}

export function handleLspStop(params: { serverId: string }): void {
  const proxy = active.get(params.serverId);
  if (!proxy) return;
  proxy.close();
  active.delete(params.serverId);
}

export interface LspServerStatus {
  languageId: string;
  command: string;
  /** Running only while the proxied child process is alive. */
  running: boolean;
  serverId?: string;
  wsUrl?: string;
  port?: number;
  pid?: number;
  startedAt?: number;
  /** Exit code when the child died on its own (crash, missing binary). */
  exitCode?: number;
}

/**
 * Every language Partner can start, annotated with the live child process.
 * Reported per configured language rather than per running proxy so the UI can
 * show "configured but not started" as a distinct state.
 */
export function handleLspStatus(): { servers: LspServerStatus[] } {
  // Drop proxies whose child already exited so the report stays truthful.
  const dead: string[] = [];
  for (const [id, proxy] of active) {
    if (proxy.child.exitCode !== null || proxy.child.signalCode !== null) {
      dead.push(id);
    }
  }

  const byLanguage = new Map<string, ActiveProxy>();
  for (const proxy of active.values()) {
    byLanguage.set(proxy.languageId, proxy);
  }

  const servers = listLspServers().map((spec: LspServerSpec) => {
    const proxy = byLanguage.get(spec.languageId);
    const command = [spec.command, ...spec.args].join(" ");
    if (!proxy) {
      return { languageId: spec.languageId, command, running: false };
    }
    const exitCode = proxy.child.exitCode;
    return {
      languageId: spec.languageId,
      command,
      running: exitCode === null && proxy.child.signalCode === null,
      serverId: proxy.id,
      wsUrl: proxy.wsUrl,
      port: proxy.port,
      ...(proxy.child.pid === undefined ? {} : { pid: proxy.child.pid }),
      startedAt: proxy.startedAt,
      ...(exitCode === null ? {} : { exitCode }),
    };
  });

  for (const id of dead) active.delete(id);
  return { servers };
}
