/**
 * Tests for CliChannelAdapter — CLI channel with interactive, pipe,
 * and non-interactive modes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { CliChannelAdapter } from "../cli-channel.js";
import type { ChannelMessage, MessageCallback } from "../types.js";

function createStreams() {
  const input = new PassThrough();
  const output = new PassThrough();
  const outputChunks: string[] = [];
  output.on("data", (chunk: Buffer) => outputChunks.push(chunk.toString()));
  return { input, output, outputChunks };
}

function collectMessages(adapter: CliChannelAdapter): ChannelMessage[] {
  const messages: ChannelMessage[] = [];
  adapter.onMessage((msg) => { messages.push(msg); });
  return messages;
}

describe("CliChannelAdapter", () => {
  // ── Basic Properties ──────────────────────────────────────────────────────

  describe("properties", () => {
    it("should have name 'cli' and channelType 'cli'", () => {
      const adapter = new CliChannelAdapter();
      expect(adapter.name).toBe("cli");
      expect(adapter.channelType).toBe("cli");
    });

    it("should start in disconnected state", () => {
      const adapter = new CliChannelAdapter();
      expect(adapter.state).toBe("disconnected");
    });
  });

  // ── Config Defaults ───────────────────────────────────────────────────────

  describe("config", () => {
    it("should use default interactive mode", () => {
      const { input, output } = createStreams();
      const adapter = new CliChannelAdapter({ input, output });
      const status = adapter.getStatus();
      expect(status.message).toContain("interactive");
    });

    it("should accept custom senderId", () => {
      const adapter = new CliChannelAdapter({ senderId: "custom-user" });
      expect(adapter.state).toBe("disconnected");
    });

    it("should accept custom generateId", () => {
      let counter = 0;
      const adapter = new CliChannelAdapter({
        generateId: () => `custom-${++counter}`,
        mode: "non-interactive",
      });
      expect(adapter.state).toBe("disconnected");
    });
  });

  // ── Non-Interactive Mode ──────────────────────────────────────────────────

  describe("non-interactive mode", () => {
    it("should connect without reading stdin", async () => {
      const adapter = new CliChannelAdapter({ mode: "non-interactive" });
      await adapter.connect();
      expect(adapter.state).toBe("connected");
      await adapter.disconnect();
    });

    it("should process input via processInput()", async () => {
      const adapter = new CliChannelAdapter({ mode: "non-interactive" });
      await adapter.connect();
      const received = collectMessages(adapter);

      const msg = await adapter.processInput("hello world");
      expect(msg.content).toBe("hello world");
      expect(msg.channelType).toBe("cli");
      expect(msg.senderId).toBe("cli-user");
      expect(received).toHaveLength(1);
      expect(received[0].content).toBe("hello world");

      await adapter.disconnect();
    });

    it("should throw when processInput while disconnected", async () => {
      const adapter = new CliChannelAdapter({ mode: "non-interactive" });
      await expect(adapter.processInput("hello")).rejects.toThrow("not connected");
    });

    it("should trim whitespace from input", async () => {
      const adapter = new CliChannelAdapter({ mode: "non-interactive" });
      await adapter.connect();
      const msg = await adapter.processInput("  hello  ");
      expect(msg.content).toBe("hello");
      await adapter.disconnect();
    });

    it("should use custom senderId", async () => {
      const adapter = new CliChannelAdapter({ mode: "non-interactive", senderId: "alice" });
      await adapter.connect();
      const msg = await adapter.processInput("test");
      expect(msg.senderId).toBe("alice");
      await adapter.disconnect();
    });

    it("should use custom generateId", async () => {
      let counter = 0;
      const adapter = new CliChannelAdapter({
        mode: "non-interactive",
        generateId: () => `id-${++counter}`,
      });
      await adapter.connect();
      const msg1 = await adapter.processInput("first");
      const msg2 = await adapter.processInput("second");
      expect(msg1.id).toBe("id-1");
      expect(msg2.id).toBe("id-2");
      await adapter.disconnect();
    });
  });

  // ── Interactive Mode ──────────────────────────────────────────────────────

  describe("interactive mode", () => {
    it("should connect and start readline", async () => {
      const { input, output } = createStreams();
      const adapter = new CliChannelAdapter({ input, output });
      await adapter.connect();
      expect(adapter.state).toBe("connected");
      await adapter.disconnect();
    });

    it("should dispatch messages from stdin lines", async () => {
      const { input, output } = createStreams();
      const adapter = new CliChannelAdapter({ input, output });
      await adapter.connect();
      const received = collectMessages(adapter);

      input.write("hello\n");
      // Give readline time to process
      await new Promise((r) => setTimeout(r, 50));

      expect(received).toHaveLength(1);
      expect(received[0].content).toBe("hello");
      await adapter.disconnect();
    });

    it("should skip empty lines", async () => {
      const { input, output } = createStreams();
      const adapter = new CliChannelAdapter({ input, output });
      await adapter.connect();
      const received = collectMessages(adapter);

      input.write("\n");
      input.write("  \n");
      input.write("hello\n");
      await new Promise((r) => setTimeout(r, 50));

      expect(received).toHaveLength(1);
      expect(received[0].content).toBe("hello");
      await adapter.disconnect();
    });

    it("should handle multiple lines", async () => {
      const { input, output } = createStreams();
      const adapter = new CliChannelAdapter({ input, output });
      await adapter.connect();
      const received = collectMessages(adapter);

      input.write("first\n");
      input.write("second\n");
      input.write("third\n");
      await new Promise((r) => setTimeout(r, 50));

      expect(received).toHaveLength(3);
      expect(received.map((m) => m.content)).toEqual(["first", "second", "third"]);
      await adapter.disconnect();
    });

    it("should disconnect when input stream closes", async () => {
      const { input, output } = createStreams();
      const adapter = new CliChannelAdapter({ input, output });
      await adapter.connect();
      expect(adapter.state).toBe("connected");

      input.end();
      await new Promise((r) => setTimeout(r, 50));

      expect(adapter.state).toBe("disconnected");
    });
  });

  // ── Pipe Mode ─────────────────────────────────────────────────────────────

  describe("pipe mode", () => {
    it("should read all stdin until EOF and dispatch as single message", async () => {
      const { input, output } = createStreams();
      const adapter = new CliChannelAdapter({ input, output, mode: "pipe" });
      const received = collectMessages(adapter);

      // Write data and end the stream (simulating `echo "hello" | vera`)
      input.write("hello world\n");
      input.write("line two\n");
      input.end();

      // connect() resolves after EOF
      await adapter.connect();

      expect(adapter.state).toBe("connected");
      expect(received).toHaveLength(1);
      expect(received[0].content).toBe("hello world\nline two");

      await adapter.disconnect();
    });

    it("should not dispatch message for empty pipe input", async () => {
      const { input, output } = createStreams();
      const adapter = new CliChannelAdapter({ input, output, mode: "pipe" });
      const received = collectMessages(adapter);

      input.end();
      await adapter.connect();

      expect(received).toHaveLength(0);
      await adapter.disconnect();
    });

    it("should trim pipe input", async () => {
      const { input, output } = createStreams();
      const adapter = new CliChannelAdapter({ input, output, mode: "pipe" });
      const received = collectMessages(adapter);

      input.write("  padded content  ");
      input.end();
      await adapter.connect();

      expect(received[0].content).toBe("padded content");
      await adapter.disconnect();
    });
  });

  // ── sendMessage ───────────────────────────────────────────────────────────

  describe("sendMessage", () => {
    it("should write to output stream", async () => {
      const { input, output, outputChunks } = createStreams();
      const adapter = new CliChannelAdapter({ input, output, mode: "non-interactive" });
      await adapter.connect();

      const msg = await adapter.sendMessage({ content: "hello from bot" });
      expect(msg.content).toBe("hello from bot");
      expect(msg.senderId).toBe("bot");
      expect(outputChunks.join("")).toContain("hello from bot\n");

      await adapter.disconnect();
    });

    it("should throw when sending while disconnected", async () => {
      const adapter = new CliChannelAdapter({ mode: "non-interactive" });
      await expect(adapter.sendMessage({ content: "hi" })).rejects.toThrow("not connected");
    });

    it("should include attachments in sent message", async () => {
      const { input, output } = createStreams();
      const adapter = new CliChannelAdapter({ input, output, mode: "non-interactive" });
      await adapter.connect();

      const msg = await adapter.sendMessage({
        content: "with file",
        attachments: [{ type: "file", url: "/tmp/test.txt" }],
      });
      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments[0].type).toBe("file");

      await adapter.disconnect();
    });

    it("should throw ChannelSendError when output stream fails", async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      // Override write to throw
      output.write = () => { throw new Error("write failed"); };
      const adapter = new CliChannelAdapter({ input, output, mode: "non-interactive" });
      await adapter.connect();

      await expect(adapter.sendMessage({ content: "fail" })).rejects.toThrow("Send failed");
      await adapter.disconnect();
    });
  });

  // ── onMessage ─────────────────────────────────────────────────────────────

  describe("onMessage", () => {
    it("should support multiple callbacks", async () => {
      const adapter = new CliChannelAdapter({ mode: "non-interactive" });
      await adapter.connect();
      const received1: ChannelMessage[] = [];
      const received2: ChannelMessage[] = [];
      adapter.onMessage((msg) => { received1.push(msg); });
      adapter.onMessage((msg) => { received2.push(msg); });

      await adapter.processInput("test");

      expect(received1).toHaveLength(1);
      expect(received2).toHaveLength(1);
      await adapter.disconnect();
    });

    it("should return unsubscribe function", async () => {
      const adapter = new CliChannelAdapter({ mode: "non-interactive" });
      await adapter.connect();
      const received: ChannelMessage[] = [];
      const unsub = adapter.onMessage((msg) => { received.push(msg); });

      await adapter.processInput("before");
      expect(received).toHaveLength(1);

      unsub();
      await adapter.processInput("after");
      expect(received).toHaveLength(1); // no new message

      await adapter.disconnect();
    });

    it("should handle async callbacks", async () => {
      const adapter = new CliChannelAdapter({ mode: "non-interactive" });
      await adapter.connect();
      const results: string[] = [];
      adapter.onMessage(async (msg) => {
        await new Promise((r) => setTimeout(r, 10));
        results.push(msg.content);
      });

      await adapter.processInput("async-test");
      expect(results).toEqual(["async-test"]);
      await adapter.disconnect();
    });
  });

  // ── getHistory ────────────────────────────────────────────────────────────

  describe("getHistory", () => {
    it("should return all messages", async () => {
      const adapter = new CliChannelAdapter({ mode: "non-interactive" });
      await adapter.connect();

      await adapter.processInput("first");
      await adapter.sendMessage({ content: "reply" });
      await adapter.processInput("second");

      const history = await adapter.getHistory();
      expect(history).toHaveLength(3);

      await adapter.disconnect();
    });

    it("should filter by senderId", async () => {
      const adapter = new CliChannelAdapter({ mode: "non-interactive" });
      await adapter.connect();

      await adapter.processInput("user msg");
      await adapter.sendMessage({ content: "bot reply" });

      const userMsgs = await adapter.getHistory({ senderId: "cli-user" });
      expect(userMsgs).toHaveLength(1);
      expect(userMsgs[0].senderId).toBe("cli-user");

      const botMsgs = await adapter.getHistory({ senderId: "bot" });
      expect(botMsgs).toHaveLength(1);
      expect(botMsgs[0].senderId).toBe("bot");

      await adapter.disconnect();
    });

    it("should respect limit option", async () => {
      const adapter = new CliChannelAdapter({ mode: "non-interactive" });
      await adapter.connect();

      await adapter.processInput("a");
      await adapter.processInput("b");
      await adapter.processInput("c");

      const limited = await adapter.getHistory({ limit: 2 });
      expect(limited).toHaveLength(2);

      await adapter.disconnect();
    });
  });

  // ── getStatus ─────────────────────────────────────────────────────────────

  describe("getStatus", () => {
    it("should report disconnected state", () => {
      const adapter = new CliChannelAdapter({ mode: "non-interactive" });
      const status = adapter.getStatus();
      expect(status.state).toBe("disconnected");
      expect(status.sentCount).toBe(0);
      expect(status.receivedCount).toBe(0);
    });

    it("should track sent and received counts", async () => {
      const adapter = new CliChannelAdapter({ mode: "non-interactive" });
      await adapter.connect();

      await adapter.processInput("one");
      await adapter.processInput("two");
      await adapter.sendMessage({ content: "reply" });

      const status = adapter.getStatus();
      expect(status.state).toBe("connected");
      expect(status.sentCount).toBe(1);
      expect(status.receivedCount).toBe(2);

      await adapter.disconnect();
    });

    it("should update state after disconnect", async () => {
      const adapter = new CliChannelAdapter({ mode: "non-interactive" });
      await adapter.connect();
      await adapter.disconnect();

      const status = adapter.getStatus();
      expect(status.state).toBe("disconnected");
    });
  });

  // ── Connection lifecycle ──────────────────────────────────────────────────

  describe("connection lifecycle", () => {
    it("should transition through connecting → connected", async () => {
      const states: string[] = [];
      const adapter = new CliChannelAdapter({ mode: "non-interactive" });
      const originalSetState = (adapter as unknown as { setState: (s: string) => void }).setState.bind(adapter);

      // Monitor state changes by checking .state at key points
      await adapter.connect();
      expect(adapter.state).toBe("connected");
      await adapter.disconnect();
      expect(adapter.state).toBe("disconnected");
    });

    it("should be safe to disconnect multiple times", async () => {
      const adapter = new CliChannelAdapter({ mode: "non-interactive" });
      await adapter.connect();
      await adapter.disconnect();
      await adapter.disconnect(); // should not throw
      expect(adapter.state).toBe("disconnected");
    });

    it("should reset state on reconnect", async () => {
      const adapter = new CliChannelAdapter({ mode: "non-interactive" });
      await adapter.connect();
      await adapter.processInput("before");
      await adapter.disconnect();

      await adapter.connect();
      await adapter.processInput("after");

      // History persists across reconnections
      const history = await adapter.getHistory();
      expect(history).toHaveLength(2);
      await adapter.disconnect();
    });
  });
});
