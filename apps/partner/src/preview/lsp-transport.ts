import type { Transport } from "@codemirror/lsp-client";

export function createWebSocketTransport(wsUrl: string): Transport {
  const socket = new WebSocket(wsUrl);
  const handlers = new Set<(value: string) => void>();

  socket.addEventListener("message", (event) => {
    const payload = typeof event.data === "string" ? event.data : "";
    for (const handler of handlers) {
      handler(payload);
    }
  });

  return {
    send(message: string) {
      if (socket.readyState !== WebSocket.OPEN) {
        throw new Error("LSP WebSocket is not open");
      }
      socket.send(message);
    },
    subscribe(handler: (value: string) => void) {
      handlers.add(handler);
    },
    unsubscribe(handler: (value: string) => void) {
      handlers.delete(handler);
    },
  };
}

export function waitForWebSocketOpen(wsUrl: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("LSP WebSocket connection timed out"));
    }, timeoutMs);

    socket.addEventListener("open", () => {
      clearTimeout(timer);
      socket.close();
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("LSP WebSocket connection failed"));
    });
  });
}
