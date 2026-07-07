import {
  handleAgentAbort,
  handleAgentRun,
  inspectEffectiveLlmConfig,
} from "./agent-run.js";
import { handleLspStart, handleLspStop } from "./lsp/handler.js";
import { handleSymbolSearch } from "./lsp/symbol-search.js";
import {
  parseLine,
  writeError,
  writeResult,
  type AgentAbortParams,
  type AgentRunParams,
  type RpcRequest,
  type ToolResultMessage,
} from "./protocol.js";

const pendingTools = new Map<
  string,
  { resolve: (value: string) => void; reject: (reason: Error) => void }
>();

function bridgeTool(
  callId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingTools.delete(callId);
      reject(new Error(`Tool call timed out: ${name}`));
    }, 120_000);

    pendingTools.set(callId, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (reason) => {
        clearTimeout(timer);
        reject(reason);
      },
    });
  });
}

function resolveToolResult(message: ToolResultMessage): void {
  const pending = pendingTools.get(message.data.callId);
  if (!pending) return;
  pendingTools.delete(message.data.callId);
  if (message.data.isError) {
    pending.resolve(`Tool failed:\n${message.data.output}`);
    return;
  }
  pending.resolve(message.data.output);
}

async function handleRequest(request: RpcRequest): Promise<void> {
  if (request.method === "agent.run") {
    await handleAgentRun(
      request.id,
      request.params as unknown as AgentRunParams,
      bridgeTool,
    );
    return;
  }
  if (request.method === "agent.abort") {
    handleAgentAbort(request.params as unknown as AgentAbortParams);
    return;
  }
  if (request.method === "agent.inspectLlmConfig") {
    const params = request.params as {
      projectRoot: string;
      llmConfig?: {
        provider: string;
        protocol: string;
        apiBaseUrl: string;
        model: string;
        apiKey: string;
      };
      revealSecrets?: boolean;
    };
    try {
      writeResult(
        request.id,
        inspectEffectiveLlmConfig(
          params.projectRoot,
          params.llmConfig,
          Boolean(params.revealSecrets),
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeError(request.id, message);
    }
    return;
  }
  if (request.method === "lsp.start") {
    try {
      const result = await handleLspStart(
        request.params as { languageId: string; workspaceRoot: string },
      );
      writeResult(request.id, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeError(request.id, message);
    }
    return;
  }
  if (request.method === "lsp.stop") {
    handleLspStop(request.params as { serverId: string });
    writeResult(request.id, { ok: true });
    return;
  }
  if (request.method === "lsp.symbolSearch") {
    try {
      const result = await handleSymbolSearch(
        request.params as {
          workspaceRoot: string;
          query: string;
          limit?: number;
        },
      );
      writeResult(request.id, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeError(request.id, message);
    }
    return;
  }
  if (request.method === "ping") {
    writeResult(request.id, { ok: true });
  }
}

async function main(): Promise<void> {
  process.stderr.write("[partner-sidecar] ready\n");
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    let parsed: ReturnType<typeof parseLine>;
    try {
      parsed = parseLine(line);
    } catch {
      process.stderr.write(`[partner-sidecar] invalid json: ${line}\n`);
      continue;
    }
    if (!parsed) continue;

    if ("type" in parsed && parsed.type === "tool_result") {
      resolveToolResult(parsed);
      continue;
    }

    void handleRequest(parsed as RpcRequest).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[partner-sidecar] request failed: ${message}\n`);
      writeError((parsed as RpcRequest).id, message);
    });
  }
}

main().catch((err) => {
  process.stderr.write(
    `[partner-sidecar] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
