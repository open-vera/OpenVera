import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import { WebhookChannelAdapter } from "../webhook-channel.js";
import type { ChannelMessage } from "../types.js";

function httpRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const opts: http.RequestOptions = {
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr).toString() } : {}),
        ...headers,
      },
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
    if (bodyStr !== undefined) {
      req.write(bodyStr);
    }
    req.end();
  });
}

function hmacHex(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

describe("WebhookChannelAdapter", () => {
  let adapter: WebhookChannelAdapter;

  afterEach(async () => {
    if (adapter) {
      await adapter.disconnect();
    }
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  describe("lifecycle", () => {
    it("starts in disconnected state", () => {
      adapter = new WebhookChannelAdapter();
      expect(adapter.state).toBe("disconnected");
    });

    it("transitions to connected on connect()", async () => {
      adapter = new WebhookChannelAdapter({ port: 0 });
      await adapter.connect();
      expect(adapter.state).toBe("connected");
      expect(adapter.port).toBeGreaterThan(0);
    });

    it("transitions to disconnected on disconnect()", async () => {
      adapter = new WebhookChannelAdapter({ port: 0 });
      await adapter.connect();
      await adapter.disconnect();
      expect(adapter.state).toBe("disconnected");
    });

    it("is idempotent for connect()", async () => {
      adapter = new WebhookChannelAdapter({ port: 0 });
      await adapter.connect();
      const port = adapter.port;
      await adapter.connect(); // second connect should be no-op
      expect(adapter.port).toBe(port);
    });

    it("handles disconnect when not connected", async () => {
      adapter = new WebhookChannelAdapter();
      await adapter.disconnect(); // should not throw
      expect(adapter.state).toBe("disconnected");
    });

    it("returns correct status", async () => {
      adapter = new WebhookChannelAdapter({ port: 0 });
      await adapter.connect();
      const status = adapter.getStatus();
      expect(status.state).toBe("connected");
      expect(status.sentCount).toBe(0);
      expect(status.receivedCount).toBe(0);
      expect(status.message).toContain("Webhook channel");
      expect(status.message).toContain("/webhook");
    });
  });

  // ── Webhook Receiving ──────────────────────────────────────────────────────

  describe("webhook receiving", () => {
    it("receives webhook with default parser (content field)", async () => {
      const received: ChannelMessage[] = [];
      adapter = new WebhookChannelAdapter({ port: 0 });
      adapter.onMessage((msg) => { received.push(msg); });
      await adapter.connect();

      const res = await httpRequest(adapter.port, "POST", "/webhook", {
        content: "hello webhook",
      });

      expect(res.status).toBe(200);
      expect(received).toHaveLength(1);
      expect(received[0]!.content).toBe("hello webhook");
      expect(received[0]!.channelType).toBe("webhook");
    });

    it("receives webhook with text field", async () => {
      const received: ChannelMessage[] = [];
      adapter = new WebhookChannelAdapter({ port: 0 });
      adapter.onMessage((msg) => { received.push(msg); });
      await adapter.connect();

      await httpRequest(adapter.port, "POST", "/webhook", {
        text: "from text field",
      });

      expect(received).toHaveLength(1);
      expect(received[0]!.content).toBe("from text field");
    });

    it("receives webhook with message field", async () => {
      const received: ChannelMessage[] = [];
      adapter = new WebhookChannelAdapter({ port: 0 });
      adapter.onMessage((msg) => { received.push(msg); });
      await adapter.connect();

      await httpRequest(adapter.port, "POST", "/webhook", {
        message: "from message field",
      });

      expect(received).toHaveLength(1);
      expect(received[0]!.content).toBe("from message field");
    });

    it("receives webhook with body field", async () => {
      const received: ChannelMessage[] = [];
      adapter = new WebhookChannelAdapter({ port: 0 });
      adapter.onMessage((msg) => { received.push(msg); });
      await adapter.connect();

      await httpRequest(adapter.port, "POST", "/webhook", {
        body: "from body field",
      });

      expect(received).toHaveLength(1);
      expect(received[0]!.content).toBe("from body field");
    });

    it("extracts senderId from senderId field", async () => {
      adapter = new WebhookChannelAdapter({ port: 0 });
      const received: ChannelMessage[] = [];
      adapter.onMessage((msg) => { received.push(msg); });
      await adapter.connect();

      await httpRequest(adapter.port, "POST", "/webhook", {
        content: "test",
        senderId: "user-42",
      });

      expect(received[0]!.senderId).toBe("user-42");
    });

    it("extracts senderId from sender field", async () => {
      adapter = new WebhookChannelAdapter({ port: 0 });
      const received: ChannelMessage[] = [];
      adapter.onMessage((msg) => { received.push(msg); });
      await adapter.connect();

      await httpRequest(adapter.port, "POST", "/webhook", {
        content: "test",
        sender: "user-abc",
      });

      expect(received[0]!.senderId).toBe("user-abc");
    });

    it("uses default senderId when not in payload", async () => {
      adapter = new WebhookChannelAdapter({ port: 0, senderId: "default-wh" });
      const received: ChannelMessage[] = [];
      adapter.onMessage((msg) => { received.push(msg); });
      await adapter.connect();

      await httpRequest(adapter.port, "POST", "/webhook", { content: "test" });

      expect(received[0]!.senderId).toBe("default-wh");
    });

    it("returns 422 for unparseable payload", async () => {
      adapter = new WebhookChannelAdapter({ port: 0 });
      await adapter.connect();

      // Body with no recognizable content field
      const res = await httpRequest(adapter.port, "POST", "/webhook", {
        foo: "bar",
        nested: { data: 123 },
      });

      expect(res.status).toBe(422);
    });

    it("returns 400 for empty body", async () => {
      adapter = new WebhookChannelAdapter({ port: 0 });
      await adapter.connect();

      const res = await httpRequest(adapter.port, "POST", "/webhook");
      expect(res.status).toBe(400);
    });

    it("returns 404 for wrong path", async () => {
      adapter = new WebhookChannelAdapter({ port: 0 });
      await adapter.connect();

      const res = await httpRequest(adapter.port, "POST", "/wrong", { content: "test" });
      expect(res.status).toBe(404);
    });

    it("returns 404 for wrong method", async () => {
      adapter = new WebhookChannelAdapter({ port: 0, methods: ["POST"] });
      await adapter.connect();

      const res = await httpRequest(adapter.port, "GET", "/webhook");
      expect(res.status).toBe(404);
    });

    it("handles OPTIONS (CORS preflight)", async () => {
      adapter = new WebhookChannelAdapter({ port: 0 });
      await adapter.connect();

      const res = await httpRequest(adapter.port, "OPTIONS", "/webhook");
      expect(res.status).toBe(204);
    });

    it("tracks received count", async () => {
      adapter = new WebhookChannelAdapter({ port: 0 });
      await adapter.connect();

      await httpRequest(adapter.port, "POST", "/webhook", { content: "a" });
      await httpRequest(adapter.port, "POST", "/webhook", { content: "b" });

      expect(adapter.getStatus().receivedCount).toBe(2);
    });
  });

  // ── Custom Path ────────────────────────────────────────────────────────────

  describe("custom path", () => {
    it("accepts webhook on custom path", async () => {
      const received: ChannelMessage[] = [];
      adapter = new WebhookChannelAdapter({ port: 0, path: "/hook" });
      adapter.onMessage((msg) => { received.push(msg); });
      await adapter.connect();

      const res = await httpRequest(adapter.port, "POST", "/hook", { content: "test" });
      expect(res.status).toBe(200);
      expect(received).toHaveLength(1);
    });

    it("rejects default path when custom path is set", async () => {
      adapter = new WebhookChannelAdapter({ port: 0, path: "/hook" });
      await adapter.connect();

      const res = await httpRequest(adapter.port, "POST", "/webhook", { content: "test" });
      expect(res.status).toBe(404);
    });
  });

  // ── Custom Methods ─────────────────────────────────────────────────────────

  describe("custom methods", () => {
    it("accepts PUT when configured", async () => {
      const received: ChannelMessage[] = [];
      adapter = new WebhookChannelAdapter({ port: 0, methods: ["PUT"] });
      adapter.onMessage((msg) => { received.push(msg); });
      await adapter.connect();

      const res = await httpRequest(adapter.port, "PUT", "/webhook", { content: "test" });
      expect(res.status).toBe(200);
      expect(received).toHaveLength(1);
    });
  });

  // ── Signature Verification — GitHub ────────────────────────────────────────

  describe("GitHub signature verification", () => {
    const secret = "github-webhook-secret-123";

    it("accepts valid GitHub signature", async () => {
      adapter = new WebhookChannelAdapter({
        port: 0,
        signature: { strategy: "github", secret },
      });
      const received: ChannelMessage[] = [];
      adapter.onMessage((msg) => { received.push(msg); });
      await adapter.connect();

      const body = JSON.stringify({ content: "push event" });
      const sig = "sha256=" + hmacHex(body, secret);

      const res = await rawPost(adapter.port, "/webhook", body, {
        "X-Hub-Signature-256": sig,
      });

      expect(res.status).toBe(200);
      expect(received).toHaveLength(1);
    });

    it("rejects invalid GitHub signature", async () => {
      adapter = new WebhookChannelAdapter({
        port: 0,
        signature: { strategy: "github", secret },
      });
      await adapter.connect();

      const body = JSON.stringify({ content: "push event" });
      const res = await rawPost(adapter.port, "/webhook", body, {
        "X-Hub-Signature-256": "sha256=invalid",
      });

      expect(res.status).toBe(401);
    });

    it("rejects missing GitHub signature header", async () => {
      adapter = new WebhookChannelAdapter({
        port: 0,
        signature: { strategy: "github", secret },
      });
      await adapter.connect();

      const res = await httpRequest(adapter.port, "POST", "/webhook", { content: "test" });
      expect(res.status).toBe(401);
    });
  });

  // ── Signature Verification — Stripe ────────────────────────────────────────

  describe("Stripe signature verification", () => {
    const secret = "stripe-webhook-secret-456";

    it("accepts valid Stripe signature", async () => {
      adapter = new WebhookChannelAdapter({
        port: 0,
        signature: { strategy: "stripe", secret },
      });
      const received: ChannelMessage[] = [];
      adapter.onMessage((msg) => { received.push(msg); });
      await adapter.connect();

      const body = JSON.stringify({ type: "payment_intent.succeeded", id: "pi_123" });
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const payload = `${timestamp}.${body}`;
      const sig = `t=${timestamp},v1=${hmacHex(payload, secret)}`;

      const res = await rawPost(adapter.port, "/webhook", body, {
        "Stripe-Signature": sig,
      });

      expect(res.status).toBe(200);
      expect(received).toHaveLength(1);
    });

    it("rejects invalid Stripe signature", async () => {
      adapter = new WebhookChannelAdapter({
        port: 0,
        signature: { strategy: "stripe", secret },
      });
      await adapter.connect();

      const body = JSON.stringify({ type: "test" });
      const res = await rawPost(adapter.port, "/webhook", body, {
        "Stripe-Signature": "t=123,v1=invalid",
      });

      expect(res.status).toBe(401);
    });
  });

  // ── Signature Verification — Slack ─────────────────────────────────────────

  describe("Slack signature verification", () => {
    const secret = "slack-signing-secret-789";

    it("accepts valid Slack signature", async () => {
      adapter = new WebhookChannelAdapter({
        port: 0,
        signature: { strategy: "slack", secret },
      });
      const received: ChannelMessage[] = [];
      adapter.onMessage((msg) => { received.push(msg); });
      await adapter.connect();

      const body = JSON.stringify({ text: "slash command" });
      const sig = "v0=" + hmacHex(body, secret);

      const res = await rawPost(adapter.port, "/webhook", body, {
        "X-Slack-Signature": sig,
      });

      expect(res.status).toBe(200);
      expect(received).toHaveLength(1);
    });

    it("rejects invalid Slack signature", async () => {
      adapter = new WebhookChannelAdapter({
        port: 0,
        signature: { strategy: "slack", secret },
      });
      await adapter.connect();

      const body = JSON.stringify({ text: "test" });
      const res = await rawPost(adapter.port, "/webhook", body, {
        "X-Slack-Signature": "v0=invalid",
      });

      expect(res.status).toBe(401);
    });
  });

  // ── Signature Verification — Custom ────────────────────────────────────────

  describe("Custom signature verification", () => {
    const secret = "custom-secret-abc";

    it("accepts valid custom signature", async () => {
      adapter = new WebhookChannelAdapter({
        port: 0,
        signature: {
          strategy: "custom",
          secret,
          headerName: "X-My-Signature",
          prefix: "",
        },
      });
      const received: ChannelMessage[] = [];
      adapter.onMessage((msg) => { received.push(msg); });
      await adapter.connect();

      const body = JSON.stringify({ content: "custom webhook" });
      const sig = hmacHex(body, secret);

      const res = await rawPost(adapter.port, "/webhook", body, {
        "X-My-Signature": sig,
      });

      expect(res.status).toBe(200);
      expect(received).toHaveLength(1);
    });

    it("uses custom prefix", async () => {
      adapter = new WebhookChannelAdapter({
        port: 0,
        signature: {
          strategy: "custom",
          secret,
          headerName: "X-Sig",
          prefix: "sig=",
        },
      });
      await adapter.connect();

      const body = JSON.stringify({ content: "test" });
      const sig = "sig=" + hmacHex(body, secret);

      const res = await rawPost(adapter.port, "/webhook", body, {
        "X-Sig": sig,
      });

      expect(res.status).toBe(200);
    });

    it("rejects wrong custom header value", async () => {
      adapter = new WebhookChannelAdapter({
        port: 0,
        signature: {
          strategy: "custom",
          secret,
          headerName: "X-Sig",
        },
      });
      await adapter.connect();

      const res = await rawPost(adapter.port, "/webhook", JSON.stringify({ content: "test" }), {
        "X-Sig": "sha256=wrong",
      });

      expect(res.status).toBe(401);
    });
  });

  // ── GitHub Payload Parser ──────────────────────────────────────────────────

  describe("GitHub payload parser", () => {
    it("parses push events", async () => {
      adapter = new WebhookChannelAdapter({
        port: 0,
        signature: { strategy: "github", secret: "s" },
      });
      const received: ChannelMessage[] = [];
      adapter.onMessage((msg) => { received.push(msg); });
      await adapter.connect();

      const body = JSON.stringify({
        action: undefined,
        pusher: { name: "octocat" },
        repository: { full_name: "octo/repo" },
        commits: [{ id: "1" }, { id: "2" }],
      });
      const sig = "sha256=" + hmacHex(body, "s");

      await rawPost(adapter.port, "/webhook", body, {
        "X-Hub-Signature-256": sig,
        "X-Github-Event": "push",
      });

      expect(received).toHaveLength(1);
      expect(received[0]!.content).toContain("octo/repo");
      expect(received[0]!.content).toContain("octocat");
      expect(received[0]!.content).toContain("2 commit(s)");
      expect(received[0]!.senderId).toBe("octocat");
    });

    it("parses issue events", async () => {
      adapter = new WebhookChannelAdapter({
        port: 0,
        signature: { strategy: "github", secret: "s" },
      });
      const received: ChannelMessage[] = [];
      adapter.onMessage((msg) => { received.push(msg); });
      await adapter.connect();

      const body = JSON.stringify({
        action: "opened",
        issue: {
          title: "Bug report",
          user: { login: "contributor" },
        },
      });
      const sig = "sha256=" + hmacHex(body, "s");

      await rawPost(adapter.port, "/webhook", body, {
        "X-Hub-Signature-256": sig,
        "X-Github-Event": "issues",
      });

      expect(received).toHaveLength(1);
      expect(received[0]!.content).toBe("[Issue opened] Bug report");
      expect(received[0]!.senderId).toBe("contributor");
    });

    it("falls back for unknown event types", async () => {
      adapter = new WebhookChannelAdapter({
        port: 0,
        signature: { strategy: "github", secret: "s" },
      });
      const received: ChannelMessage[] = [];
      adapter.onMessage((msg) => { received.push(msg); });
      await adapter.connect();

      const body = JSON.stringify({ foo: "bar" });
      const sig = "sha256=" + hmacHex(body, "s");

      await rawPost(adapter.port, "/webhook", body, {
        "X-Hub-Signature-256": sig,
        "X-Github-Event": "deployment",
      });

      expect(received).toHaveLength(1);
      expect(received[0]!.content).toContain("deployment");
    });
  });

  // ── Stripe Payload Parser ──────────────────────────────────────────────────

  describe("Stripe payload parser", () => {
    it("parses Stripe events", async () => {
      adapter = new WebhookChannelAdapter({
        port: 0,
        signature: { strategy: "stripe", secret: "s" },
      });
      const received: ChannelMessage[] = [];
      adapter.onMessage((msg) => { received.push(msg); });
      await adapter.connect();

      const body = JSON.stringify({
        type: "payment_intent.succeeded",
        id: "pi_3xyz",
      });
      const ts = Math.floor(Date.now() / 1000).toString();
      const sig = `t=${ts},v1=${hmacHex(`${ts}.${body}`, "s")}`;

      await rawPost(adapter.port, "/webhook", body, {
        "Stripe-Signature": sig,
      });

      expect(received).toHaveLength(1);
      expect(received[0]!.content).toContain("payment_intent.succeeded");
      expect(received[0]!.senderId).toBe("stripe");
    });
  });

  // ── Custom Payload Parser ──────────────────────────────────────────────────

  describe("custom payload parser", () => {
    it("uses custom parser when provided", async () => {
      adapter = new WebhookChannelAdapter({
        port: 0,
        parser: (body) => {
          const event = body.event as string;
          return { content: `Custom: ${event}`, senderId: "custom-parser" };
        },
      });
      const received: ChannelMessage[] = [];
      adapter.onMessage((msg) => { received.push(msg); });
      await adapter.connect();

      await httpRequest(adapter.port, "POST", "/webhook", { event: "order.created" });

      expect(received).toHaveLength(1);
      expect(received[0]!.content).toBe("Custom: order.created");
      expect(received[0]!.senderId).toBe("custom-parser");
    });

    it("custom parser returning null yields 422", async () => {
      adapter = new WebhookChannelAdapter({
        port: 0,
        parser: () => null,
      });
      await adapter.connect();

      const res = await httpRequest(adapter.port, "POST", "/webhook", { content: "test" });
      expect(res.status).toBe(422);
    });

    it("custom parser receives headers", async () => {
      let capturedHeaders: Record<string, string> = {};
      adapter = new WebhookChannelAdapter({
        port: 0,
        parser: (_body, headers) => {
          capturedHeaders = headers;
          return { content: "parsed" };
        },
      });
      await adapter.connect();

      await httpRequest(adapter.port, "POST", "/webhook", { x: 1 }, {
        "X-Custom-Header": "custom-value",
      });

      expect(capturedHeaders["x-custom-header"]).toBe("custom-value");
    });
  });

  // ── sendMessage ────────────────────────────────────────────────────────────

  describe("sendMessage", () => {
    it("throws when not connected", async () => {
      adapter = new WebhookChannelAdapter();
      await expect(adapter.sendMessage({ content: "test" })).rejects.toThrow("not connected");
    });

    it("records outbound message in history", async () => {
      adapter = new WebhookChannelAdapter({ port: 0 });
      await adapter.connect();

      const msg = await adapter.sendMessage({ content: "outgoing" });
      expect(msg.content).toBe("outgoing");
      expect(msg.senderId).toBe("bot");
      expect(msg.channelType).toBe("webhook");

      const history = await adapter.getHistory();
      expect(history).toHaveLength(1);
      expect(adapter.getStatus().sentCount).toBe(1);
    });
  });

  // ── onMessage ──────────────────────────────────────────────────────────────

  describe("onMessage", () => {
    it("unsubscribes correctly", async () => {
      adapter = new WebhookChannelAdapter({ port: 0 });
      await adapter.connect();

      const messages: ChannelMessage[] = [];
      const unsub = adapter.onMessage((msg) => { messages.push(msg); });

      await httpRequest(adapter.port, "POST", "/webhook", { content: "a" });
      expect(messages).toHaveLength(1);

      unsub();
      await httpRequest(adapter.port, "POST", "/webhook", { content: "b" });
      expect(messages).toHaveLength(1);
    });
  });

  // ── getHistory ─────────────────────────────────────────────────────────────

  describe("getHistory", () => {
    it("filters by senderId", async () => {
      adapter = new WebhookChannelAdapter({ port: 0 });
      await adapter.connect();

      await httpRequest(adapter.port, "POST", "/webhook", { content: "a", senderId: "u1" });
      await httpRequest(adapter.port, "POST", "/webhook", { content: "b", senderId: "u2" });

      const history = await adapter.getHistory({ senderId: "u1" });
      expect(history).toHaveLength(1);
      expect(history[0]!.senderId).toBe("u1");
    });

    it("limits results", async () => {
      adapter = new WebhookChannelAdapter({ port: 0 });
      await adapter.connect();

      await httpRequest(adapter.port, "POST", "/webhook", { content: "a" });
      await httpRequest(adapter.port, "POST", "/webhook", { content: "b" });
      await httpRequest(adapter.port, "POST", "/webhook", { content: "c" });

      const history = await adapter.getHistory({ limit: 2 });
      expect(history).toHaveLength(2);
    });
  });

  // ── Custom Response ────────────────────────────────────────────────────────

  describe("custom response", () => {
    it("returns custom status code on success", async () => {
      adapter = new WebhookChannelAdapter({ port: 0, successStatusCode: 202 });
      await adapter.connect();

      const res = await httpRequest(adapter.port, "POST", "/webhook", { content: "test" });
      expect(res.status).toBe(202);
    });

    it("returns custom body on success", async () => {
      adapter = new WebhookChannelAdapter({
        port: 0,
        successBody: '{"status":"received"}',
      });
      await adapter.connect();

      const res = await httpRequest(adapter.port, "POST", "/webhook", { content: "test" });
      expect(res.body).toEqual({ status: "received" });
    });
  });

  // ── Edge Cases ─────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("default senderId is used when not specified", async () => {
      adapter = new WebhookChannelAdapter({ port: 0 });
      const received: ChannelMessage[] = [];
      adapter.onMessage((msg) => { received.push(msg); });
      await adapter.connect();

      await httpRequest(adapter.port, "POST", "/webhook", { content: "test" });
      expect(received[0]!.senderId).toBe("webhook");
    });

    it("custom senderId in config", async () => {
      adapter = new WebhookChannelAdapter({ port: 0, senderId: "custom-wh" });
      const received: ChannelMessage[] = [];
      adapter.onMessage((msg) => { received.push(msg); });
      await adapter.connect();

      await httpRequest(adapter.port, "POST", "/webhook", { content: "test" });
      expect(received[0]!.senderId).toBe("custom-wh");
    });

    it("multiple callbacks all receive the message", async () => {
      adapter = new WebhookChannelAdapter({ port: 0 });
      await adapter.connect();

      const msgs1: ChannelMessage[] = [];
      const msgs2: ChannelMessage[] = [];
      adapter.onMessage((msg) => { msgs1.push(msg); });
      adapter.onMessage((msg) => { msgs2.push(msg); });

      await httpRequest(adapter.port, "POST", "/webhook", { content: "test" });

      expect(msgs1).toHaveLength(1);
      expect(msgs2).toHaveLength(1);
    });
  });
});

// ── Helper for raw POST with exact body ──────────────────────────────────────

function rawPost(
  port: number,
  path: string,
  body: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      hostname: "127.0.0.1",
      port,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body).toString(),
        ...headers,
      },
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
    req.write(body);
    req.end();
  });
}
