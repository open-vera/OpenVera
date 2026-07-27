import { spawn, type ChildProcess } from "node:child_process";
import { listLspServers, type LspServerSpec } from "./config.js";

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { message?: string };
}

interface SymbolLocation {
  uri: string;
  range?: unknown;
}

interface WorkspaceSymbol {
  name?: string;
  kind?: number;
  location?: SymbolLocation;
}

export interface SymbolSearchResult {
  name: string;
  kind: string;
  path: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface LspSearchClient {
  spec: LspServerSpec;
  child: ChildProcess;
  ready: Promise<void>;
  pending: Map<number, PendingRequest>;
  nextId: number;
  buffer: Buffer;
}

const clients = new Map<string, LspSearchClient>();

const SYMBOL_KIND: Record<number, string> = {
  1: "File",
  2: "Module",
  3: "Namespace",
  4: "Package",
  5: "Class",
  6: "Method",
  7: "Property",
  8: "Field",
  9: "Constructor",
  10: "Enum",
  11: "Interface",
  12: "Function",
  13: "Variable",
  14: "Constant",
  15: "String",
  16: "Number",
  17: "Boolean",
  18: "Array",
  19: "Object",
  20: "Key",
  21: "Null",
  22: "EnumMember",
  23: "Struct",
  24: "Event",
  25: "Operator",
  26: "TypeParameter",
};

function writeLspMessage(stream: NodeJS.WritableStream, message: unknown): void {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  stream.write(`Content-Length: ${body.length}\r\n\r\n`);
  stream.write(body);
}

function writeClientMessage(client: LspSearchClient, message: unknown): void {
  if (!client.child.stdin) {
    throw new Error(`LSP stdin unavailable: ${client.spec.languageId}`);
  }
  writeLspMessage(client.child.stdin, message);
}

function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  return typeof value === "object" && value !== null;
}

function handleMessage(client: LspSearchClient, message: string): void {
  const parsed = JSON.parse(message) as unknown;
  if (!isJsonRpcMessage(parsed) || parsed.id == null) return;

  const requestId = Number(parsed.id);
  const pending = client.pending.get(requestId);
  if (!pending) return;

  client.pending.delete(requestId);
  clearTimeout(pending.timer);
  if (parsed.error) {
    pending.reject(new Error(parsed.error.message ?? "LSP request failed"));
    return;
  }
  pending.resolve(parsed.result);
}

function attachStdoutReader(client: LspSearchClient): void {
  client.child.stdout?.on("data", (chunk: Buffer) => {
    client.buffer = Buffer.concat([client.buffer, chunk]);

    while (true) {
      const headerEnd = client.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = client.buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        client.buffer = client.buffer.subarray(headerEnd + 4);
        continue;
      }

      const length = Number.parseInt(match[1] ?? "0", 10);
      const bodyStart = headerEnd + 4;
      if (client.buffer.length < bodyStart + length) break;

      const body = client.buffer
        .subarray(bodyStart, bodyStart + length)
        .toString("utf8");
      client.buffer = client.buffer.subarray(bodyStart + length);
      handleMessage(client, body);
    }
  });
}

function request(
  client: LspSearchClient,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<unknown> {
  const id = client.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.pending.delete(id);
      reject(new Error(`LSP request timed out: ${method}`));
    }, timeoutMs);
    client.pending.set(id, { resolve, reject, timer });
    writeClientMessage(client, {
      jsonrpc: "2.0",
      id,
      method,
      params,
    });
  });
}

function notify(
  client: LspSearchClient,
  method: string,
  params: Record<string, unknown>,
): void {
  writeClientMessage(client, {
    jsonrpc: "2.0",
    method,
    params,
  });
}

function createClient(spec: LspServerSpec, workspaceRoot: string): LspSearchClient {
  const child = spawn(spec.command, spec.args, {
    cwd: workspaceRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  const client: LspSearchClient = {
    spec,
    child,
    pending: new Map(),
    nextId: 1,
    buffer: Buffer.alloc(0),
    ready: Promise.resolve(),
  };

  attachStdoutReader(client);
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[lsp:${spec.languageId}] ${chunk.toString("utf8")}`);
  });
  child.on("exit", () => {
    clients.delete(spec.languageId);
    for (const pending of client.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`LSP server exited: ${spec.languageId}`));
    }
    client.pending.clear();
  });

  client.ready = request(client, "initialize", {
    processId: process.pid,
    rootUri: pathToFileUri(workspaceRoot),
    capabilities: {
      workspace: {
        symbol: {
          dynamicRegistration: false,
        },
      },
    },
  }).then(() => {
    notify(client, "initialized", {});
  });

  return client;
}

function pathToFileUri(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `file://${normalized}`;
}

function fileUriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  return decodeURIComponent(uri.slice("file://".length));
}

function toWorkspaceSymbols(value: unknown): WorkspaceSymbol[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is WorkspaceSymbol => {
    if (typeof item !== "object" || item === null) return false;
    const symbol = item as WorkspaceSymbol;
    return typeof symbol.name === "string" && Boolean(symbol.location?.uri);
  });
}

async function getClient(
  spec: LspServerSpec,
  workspaceRoot: string,
): Promise<LspSearchClient> {
  const existing = clients.get(spec.languageId);
  if (existing) {
    await existing.ready;
    return existing;
  }

  const created = createClient(spec, workspaceRoot);
  clients.set(spec.languageId, created);
  await created.ready;
  return created;
}

function defaultSearchSpecs(): LspServerSpec[] {
  return listLspServers();
}

export async function handleSymbolSearch(params: {
  workspaceRoot: string;
  query: string;
  limit?: number;
}): Promise<{ results: SymbolSearchResult[] }> {
  const query = params.query.trim();
  if (!query) return { results: [] };

  const limit = Math.min(Math.max(params.limit ?? 80, 1), 200);
  const results: SymbolSearchResult[] = [];

  for (const spec of defaultSearchSpecs()) {
    if (results.length >= limit) break;
    try {
      const client = await getClient(spec, params.workspaceRoot);
      const response = await request(
        client,
        "workspace/symbol",
        { query },
        3000,
      );
      for (const symbol of toWorkspaceSymbols(response)) {
        if (results.length >= limit) break;
        results.push({
          name: symbol.name ?? "",
          kind: SYMBOL_KIND[symbol.kind ?? 0] ?? "Symbol",
          path: fileUriToPath(symbol.location?.uri ?? ""),
        });
      }
    } catch (error) {
      process.stderr.write(
        `[lsp-search] ${spec.languageId}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }

  return { results };
}
