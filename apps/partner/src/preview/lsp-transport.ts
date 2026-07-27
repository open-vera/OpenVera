import type { Transport } from "@codemirror/lsp-client";

export type LspTransportHandle = {
  transport: Transport;
  close: () => void;
};

/**
 * Open a WebSocket and only return the transport after it is ready.
 * Callers must use this same socket for LSP — do not probe with a throwaway connection.
 */
export async function connectLspTransport(
  wsUrl: string,
  timeoutMs = 8_000,
): Promise<LspTransportHandle> {
  const socket = new WebSocket(wsUrl);
  const handlers = new Set<(value: string) => void>();

  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      socket.close();
      reject(new Error("LSP WebSocket connection timed out"));
    }, timeoutMs);

    const onOpen = () => {
      window.clearTimeout(timer);
      cleanup();
      resolve();
    };
    const onError = () => {
      window.clearTimeout(timer);
      cleanup();
      reject(new Error("LSP WebSocket connection failed"));
    };
    const cleanup = () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
    };

    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
  });

  socket.addEventListener("message", (event) => {
    const payload = typeof event.data === "string" ? event.data : "";
    for (const handler of handlers) {
      handler(payload);
    }
  });

  return {
    transport: {
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
    },
    close: () => {
      handlers.clear();
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close();
      }
    },
  };
}

/** @deprecated Prefer {@link connectLspTransport}; kept for tests of the old probe helper. */
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

/** @deprecated Prefer {@link connectLspTransport}. */
export function waitForWebSocketOpen(wsUrl: string, timeoutMs = 5000): Promise<void> {
  return connectLspTransport(wsUrl, timeoutMs).then((handle) => {
    handle.close();
  });
}
