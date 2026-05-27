import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import { ApiChannelAdapter } from "../api-channel.js";
import type { ChannelMessage } from "../types.js";

function httpRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: { "Content-Type": "application/json", ...headers },
    };
    const req = http.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("error", reject);
    if (body !== undefined) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

describe("ApiChannelAdapter", () => {
  let adapter: ApiChannelAdapter;

  afterEach(async () => {
    if (adapter) {
      await adapter.disconnect();
    }
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  describe("lifecycle", () => {
    it("starts in disconnected state", () => {
      adapter = new ApiChannelAdapter();
      expect(adapter.state).toBe("disconnected");
    });

    it("transitions to connected on connect()", async () => {
      adapter = new ApiChannelAdapter({ port: 0 });
      await adapter.connect();
      expect(adapter.state).toBe("connected");
      expect(adapter.port).toBeGreaterThan(0);
    });

    it("transitions to disconnected on disconnect()", async () => {
      adapter = new ApiChannelAdapter({ port: 0 });
      await adapter.connect();
      await adapter.disconnect();
      expect(adapter.state).toBe("disconnected");
    });

    it("is idempotent for connect()", async () => {
      adapter = new ApiChannelAdapter({ port: 0 });
      await adapter.connect();
      const port = adapter.port;
      await adapter.connect(); // second connect should be no-op
      expect(adapter.port).toBe(port);
    });

    it("handles disconnect when not connected", async () => {
      adapter = new ApiChannelAdapter();
      await adapter.disconnect(); // should not throw
      expect(adapter.state).toBe("disconnected");
    });

    it("returns correct status", async () => {
      adapter = new ApiChannelAdapter({ port: 0 });
      await adapter.connect();
      const status = adapter.getStatus();
      expect(status.state).toBe("connected");
      expect(status.sentCount).toBe(0);
      expect(status.receivedCount).toBe(0);
      expect(status.message).toContain("API channel");
    });
  });

  // ── REST API ───────────────────────────────────────────────────────────────

  describe("REST API", () => {
    it("POST /messages creates and dispatches a message", async () => {
      const received: ChannelMessage[] = [];
      adapter = new ApiChannelAdapter({ port: 0 });
      adapter.onMessage((msg) => { received.push(msg); });
      await adapter.connect();

      const res = await httpRequest(adapter.port, "POST", "/messages", {
        content: "hello from REST",
      });

      expect(res.status).toBe(201);
      const body = res.body as { message: ChannelMessage };
      expect(body.message.content).toBe("hello from REST");
      expect(body.message.channelType).toBe("api");
      expect(received).toHaveLength(1);
      expect(received[0]!.content).toBe("hello from REST");
    });

    it("POST /messages with custom senderId", async () => {
      adapter = new ApiChannelAdapter({ port: 0 });
      await adapter.connect();

      const res = await httpRequest(adapter.port, "POST", "/messages", {
        content: "test",
        senderId: "user-42",
      });

      const body = res.body as { message: ChannelMessage };
      expect(body.message.senderId).toBe("user-42");
    });

    it("POST /messages returns 400 for empty content", async () => {
      adapter = new ApiChannelAdapter({ port: 0 });
      await adapter.connect();

      const res = await httpRequest(adapter.port, "POST", "/messages", { content: "" });
      expect(res.status).toBe(400);
    });

    it("POST /messages returns 400 for missing content", async () => {
      adapter = new ApiChannelAdapter({ port: 0 });
      await adapter.connect();

      const res = await httpRequest(adapter.port, "POST", "/messages", { foo: "bar" });
      expect(res.status).toBe(400);
    });

    it("GET /messages returns history", async () => {
      adapter = new ApiChannelAdapter({ port: 0 });
      await adapter.connect();

      await httpRequest(adapter.port, "POST", "/messages", { content: "msg1" });
      await httpRequest(adapter.port, "POST", "/messages", { content: "msg2" });

      const res = await httpRequest(adapter.port, "GET", "/messages");
      const body = res.body as { messages: ChannelMessage[] };
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0]!.content).toBe("msg1");
      expect(body.messages[1]!.content).toBe("msg2");
    });

    it("GET /messages with limit", async () => {
      adapter = new ApiChannelAdapter({ port: 0 });
      await adapter.connect();

      await httpRequest(adapter.port, "POST", "/messages", { content: "a" });
      await httpRequest(adapter.port, "POST", "/messages", { content: "b" });
      await httpRequest(adapter.port, "POST", "/messages", { content: "c" });

      const res = await httpRequest(adapter.port, "GET", "/messages?limit=2");
      const body = res.body as { messages: ChannelMessage[] };
      expect(body.messages).toHaveLength(2);
    });

    it("GET /messages with senderId filter", async () => {
      adapter = new ApiChannelAdapter({ port: 0 });
      await adapter.connect();

      await httpRequest(adapter.port, "POST", "/messages", { content: "a", senderId: "u1" });
      await httpRequest(adapter.port, "POST", "/messages", { content: "b", senderId: "u2" });

      const res = await httpRequest(adapter.port, "GET", "/messages?senderId=u1");
      const body = res.body as { messages: ChannelMessage[] };
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0]!.senderId).toBe("u1");
    });

    it("GET /status returns adapter status", async () => {
      adapter = new ApiChannelAdapter({ port: 0 });
      await adapter.connect();

      const res = await httpRequest(adapter.port, "GET", "/status");
      expect(res.status).toBe(200);
      const body = res.body as { state: string };
      expect(body.state).toBe("connected");
    });

    it("returns 404 for unknown routes", async () => {
      adapter = new ApiChannelAdapter({ port: 0 });
      await adapter.connect();

      const res = await httpRequest(adapter.port, "GET", "/nonexistent");
      expect(res.status).toBe(404);
    });

    it("handles OPTIONS (CORS preflight)", async () => {
      adapter = new ApiChannelAdapter({ port: 0 });
      await adapter.connect();

      const res = await httpRequest(adapter.port, "OPTIONS", "/messages");
      expect(res.status).toBe(204);
    });
  });

  // ── Authentication ─────────────────────────────────────────────────────────

  describe("authentication", () => {
    it("rejects requests without API key when configured", async () => {
      adapter = new ApiChannelAdapter({ port: 0, apiKey: "secret" });
      await adapter.connect();

      const res = await httpRequest(adapter.port, "GET", "/status");
      expect(res.status).toBe(401);
    });

    it("accepts requests with valid Bearer token", async () => {
      adapter = new ApiChannelAdapter({ port: 0, apiKey: "secret" });
      await adapter.connect();

      const res = await httpRequest(adapter.port, "GET", "/status", undefined, {
        Authorization: "Bearer secret",
      });
      expect(res.status).toBe(200);
    });

    it("rejects requests with wrong API key", async () => {
      adapter = new ApiChannelAdapter({ port: 0, apiKey: "secret" });
      await adapter.connect();

      const res = await httpRequest(adapter.port, "GET", "/status", undefined, {
        Authorization: "Bearer wrong",
      });
      expect(res.status).toBe(401);
    });
  });

  // ── sendMessage ────────────────────────────────────────────────────────────

  describe("sendMessage", () => {
    it("throws when not connected", async () => {
      adapter = new ApiChannelAdapter();
      await expect(adapter.sendMessage({ content: "test" })).rejects.toThrow("not connected");
    });

    it("sends and records in history", async () => {
      adapter = new ApiChannelAdapter({ port: 0 });
      await adapter.connect();

      const msg = await adapter.sendMessage({ content: "outgoing" });
      expect(msg.content).toBe("outgoing");
      expect(msg.senderId).toBe("bot");
      expect(msg.channelType).toBe("api");

      const history = await adapter.getHistory();
      expect(history).toHaveLength(1);
      expect(adapter.getStatus().sentCount).toBe(1);
    });
  });

  // ── onMessage ──────────────────────────────────────────────────────────────

  describe("onMessage", () => {
    it("unsubscribes correctly", async () => {
      adapter = new ApiChannelAdapter({ port: 0 });
      await adapter.connect();

      const messages: ChannelMessage[] = [];
      const unsub = adapter.onMessage((msg) => { messages.push(msg); });

      await httpRequest(adapter.port, "POST", "/messages", { content: "a" });
      expect(messages).toHaveLength(1);

      unsub();
      await httpRequest(adapter.port, "POST", "/messages", { content: "b" });
      expect(messages).toHaveLength(1); // still 1
    });
  });

  // ── WebSocket ──────────────────────────────────────────────────────────────

  describe("WebSocket", () => {
    function wsConnect(
      port: number,
      token?: string,
    ): Promise<{ socket: import("node:net").Socket; messages: unknown[] }> {
      return new Promise((resolve, reject) => {
        const key = crypto.randomBytes(16).toString("base64");
        const path = token ? `/?token=${token}` : "/";
        const req = http.request({
          hostname: "127.0.0.1",
          port,
          path,
          method: "GET",
          headers: {
            Upgrade: "websocket",
            Connection: "Upgrade",
            "Sec-WebSocket-Key": key,
            "Sec-WebSocket-Version": "13",
          },
        });

        req.on("upgrade", (res, socket) => {
          const messages: unknown[] = [];
          let buf = Buffer.alloc(0);

          socket.on("data", (data: Buffer) => {
            buf = Buffer.concat([buf, data]);
            // Parse WS frames
            while (buf.length >= 2) {
              const opcode = buf[0]! & 0x0f;
              let payloadLen = buf[1]! & 0x7f;
              let offset = 2;
              if (payloadLen === 126) {
                if (buf.length < 4) break;
                payloadLen = (buf[2]! << 8) | buf[3]!;
                offset = 4;
              } else if (payloadLen === 127) {
                if (buf.length < 10) break;
                payloadLen = Number(buf.readBigUInt64BE(2));
                offset = 10;
              }
              if (buf.length < offset + payloadLen) break;

              const payload = buf.slice(offset, offset + payloadLen);
              buf = buf.slice(offset + payloadLen);

              if (opcode === 0x01) {
                // Text
                try {
                  messages.push(JSON.parse(payload.toString("utf-8")));
                } catch {
                  // ignore
                }
              }
              // 0x08 = close, 0x09 = ping, 0x0a = pong — skip
            }
          });

          resolve({ socket: socket as import("node:net").Socket, messages });
        });

        req.on("error", reject);
        req.end();
      });
    }

    function wsSend(socket: import("node:net").Socket, data: unknown): void {
      const payload = Buffer.from(JSON.stringify(data), "utf-8");
      // Build a masked client frame (required by RFC 6455)
      const mask = crypto.randomBytes(4);
      let header: Buffer;
      if (payload.length < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x81; // FIN + text
        header[1] = 0x80 | payload.length; // masked
      } else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(payload.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
      }
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) {
        masked[i] = payload[i]! ^ mask[i % 4]!;
      }
      socket.write(Buffer.concat([header, mask, masked]));
    }

    it("accepts WebSocket connections and receives messages", async () => {
      adapter = new ApiChannelAdapter({ port: 0 });
      const received: ChannelMessage[] = [];
      adapter.onMessage((msg) => { received.push(msg); });
      await adapter.connect();

      const { socket, messages } = await wsConnect(adapter.port);

      // Wait for connection to establish
      await new Promise((r) => setTimeout(r, 50));

      wsSend(socket, { type: "message", content: "hello ws" });

      // Wait for message processing
      await new Promise((r) => setTimeout(r, 100));

      expect(received).toHaveLength(1);
      expect(received[0]!.content).toBe("hello ws");

      // Should receive ack
      const ack = messages.find((m: any) => m.type === "ack");
      expect(ack).toBeDefined();

      socket.destroy();
    });

    it("broadcasts sent messages to WS clients", async () => {
      adapter = new ApiChannelAdapter({ port: 0 });
      await adapter.connect();

      const { socket, messages } = await wsConnect(adapter.port);
      await new Promise((r) => setTimeout(r, 50));

      await adapter.sendMessage({ content: "broadcast" });
      await new Promise((r) => setTimeout(r, 100));

      const msgEvent = messages.find((m: any) => m.type === "message");
      expect(msgEvent).toBeDefined();
      expect((msgEvent as any).data.content).toBe("broadcast");

      socket.destroy();
    });

    it("rejects WS without API key when configured", async () => {
      adapter = new ApiChannelAdapter({ port: 0, apiKey: "secret" });
      await adapter.connect();

      // No token → server sends 401 and destroys socket, client gets 'error' or regular HTTP response
      // wsConnect only listens for 'upgrade', so we test with a raw request
      const result = await new Promise<{ status: number }>((resolve, reject) => {
        const key = crypto.randomBytes(16).toString("base64");
        const req = http.request({
          hostname: "127.0.0.1",
          port: adapter.port,
          path: "/",
          method: "GET",
          headers: {
            Upgrade: "websocket",
            Connection: "Upgrade",
            "Sec-WebSocket-Key": key,
            "Sec-WebSocket-Version": "13",
          },
        });
        req.on("response", (res) => {
          resolve({ status: res.statusCode ?? 0 });
        });
        req.on("error", reject);
        req.end();
      });
      expect(result.status).toBe(401);
    });

    it("accepts WS with valid API key", async () => {
      adapter = new ApiChannelAdapter({ port: 0, apiKey: "secret" });
      await adapter.connect();

      const { socket } = await wsConnect(adapter.port, "secret");
      expect(adapter.getStatus().message).toContain("WS clients");
      socket.destroy();
    });

    it("responds to WS ping with pong", async () => {
      adapter = new ApiChannelAdapter({ port: 0 });
      await adapter.connect();

      const { socket, messages } = await wsConnect(adapter.port);
      await new Promise((r) => setTimeout(r, 50));

      wsSend(socket, { type: "ping" });
      await new Promise((r) => setTimeout(r, 100));

      const pong = messages.find((m: any) => m.type === "pong");
      expect(pong).toBeDefined();

      socket.destroy();
    });
  });

  // ── Edge Cases ─────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("tracks received count from REST", async () => {
      adapter = new ApiChannelAdapter({ port: 0 });
      await adapter.connect();

      await httpRequest(adapter.port, "POST", "/messages", { content: "a" });
      await httpRequest(adapter.port, "POST", "/messages", { content: "b" });

      expect(adapter.getStatus().receivedCount).toBe(2);
    });

    it("default senderId is used when not specified", async () => {
      adapter = new ApiChannelAdapter({ port: 0 });
      await adapter.connect();

      const res = await httpRequest(adapter.port, "POST", "/messages", { content: "test" });
      const body = res.body as { message: ChannelMessage };
      expect(body.message.senderId).toBe("api-client");
    });

    it("custom senderId in config", async () => {
      adapter = new ApiChannelAdapter({ port: 0, senderId: "custom-id" });
      await adapter.connect();

      const res = await httpRequest(adapter.port, "POST", "/messages", { content: "test" });
      const body = res.body as { message: ChannelMessage };
      expect(body.message.senderId).toBe("custom-id");
    });
  });
});
