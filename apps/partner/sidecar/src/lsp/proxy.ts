import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { WebSocketServer, type WebSocket } from "ws";
import type { LspServerSpec } from "./config.js";

function writeLspMessage(
  stream: NodeJS.WritableStream,
  message: string,
): void {
  const body = Buffer.from(message, "utf8");
  stream.write(`Content-Length: ${body.length}\r\n\r\n`);
  stream.write(body);
}

function attachStdoutReader(
  stream: NodeJS.ReadableStream,
  onMessage: (message: string) => void,
): void {
  let buffer = Buffer.alloc(0);

  stream.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }

      const length = Number.parseInt(match[1] ?? "0", 10);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) break;

      const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      buffer = buffer.subarray(bodyStart + length);
      onMessage(body);
    }
  });
}

export async function startLspProxy(
  spec: LspServerSpec,
  workspaceRoot: string,
): Promise<{ port: number; child: ChildProcess; close: () => void }> {
  const child = spawn(spec.command, spec.args, {
    cwd: workspaceRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  const sockets = new Set<WebSocket>();
  let closed = false;

  attachStdoutReader(child.stdout, (message) => {
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) {
        socket.send(message);
      }
    }
  });

  wss.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("message", (data) => {
      const payload = typeof data === "string" ? data : data.toString("utf8");
      writeLspMessage(child.stdin, payload);
    });
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  const close = () => {
    if (closed) return;
    closed = true;
    for (const socket of sockets) {
      socket.close();
    }
    wss.close();
    httpServer.close();
    if (!child.killed) {
      child.kill();
    }
  };

  child.on("error", (error) => {
    process.stderr.write(
      `[partner-sidecar] LSP server failed (${spec.command}): ${error.message}\n`,
    );
    close();
  });

  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => {
      cleanup();
      close();
      reject(error);
    };
    const succeed = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      httpServer.off("error", fail);
      child.off("error", fail);
    };

    httpServer.once("error", fail);
    child.once("error", fail);
    httpServer.listen(0, "127.0.0.1", succeed);
  });

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    close();
    throw new Error("failed to bind LSP proxy port");
  }

  child.on("exit", close);

  return { port: address.port, child, close };
}
