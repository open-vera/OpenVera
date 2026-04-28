import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { maybeWriteGitBranch, previewToChatMessages, resumedVisibleMessages } from "../src/repl/ui/utils.js";
import { SessionStore } from "../src/session/store.js";
import type { SessionTranscriptPreview } from "../src/session/types.js";

describe("repl/ui/utils", () => {
  let tempDir: string;
  const originalVeraHome = process.env.VERA_HOME;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "vera-ui-utils-test-"));
    process.env.VERA_HOME = tempDir;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    process.env.VERA_HOME = originalVeraHome;
  });

  describe("maybeWriteGitBranch", () => {
    it("reads .git/HEAD and writes the branch name to store", () => {
      const cwd = mkdtempSync(join(tempDir, "project-"));
      const gitDir = join(cwd, ".git");
      require("node:fs").mkdirSync(gitDir, { recursive: true });
      writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");

      const store = new SessionStore({ cwd });
      const writeSpy = vi.spyOn(store, "writeGitBranch");

      maybeWriteGitBranch(store, cwd);

      expect(writeSpy).toHaveBeenCalledWith("main");
      writeSpy.mockRestore();
    });

    it("handles missing .git directory gracefully", () => {
      const cwd = mkdtempSync(join(tempDir, "project-"));
      const store = new SessionStore({ cwd });
      const writeSpy = vi.spyOn(store, "writeGitBranch");

      maybeWriteGitBranch(store, cwd);

      expect(writeSpy).not.toHaveBeenCalled();
      writeSpy.mockRestore();
    });

    it("handles detached HEAD state", () => {
      const cwd = mkdtempSync(join(tempDir, "project-"));
      const gitDir = join(cwd, ".git");
      require("node:fs").mkdirSync(gitDir, { recursive: true });
      writeFileSync(join(gitDir, "HEAD"), "abc1234567890def\n");

      const store = new SessionStore({ cwd });
      const writeSpy = vi.spyOn(store, "writeGitBranch");

      maybeWriteGitBranch(store, cwd);

      expect(writeSpy).toHaveBeenCalledWith("abc1234567890def");
      writeSpy.mockRestore();
    });
  });

  describe("previewToChatMessages", () => {
    it("converts transcript preview messages to chat messages", () => {
      const preview: SessionTranscriptPreview = {
        sessionId: "test-session",
        messages: [
          {
            role: "user",
            content: "What is 2+2?",
          },
          {
            role: "assistant",
            content: "The answer is 4.",
          },
        ],
      };

      const result = previewToChatMessages(preview);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ role: "user", content: "What is 2+2?" });
      expect(result[1]).toEqual({ role: "assistant", content: "The answer is 4." });
    });

    it("preserves tool uses in messages", () => {
      const preview: SessionTranscriptPreview = {
        sessionId: "test-session",
        messages: [
          {
            role: "assistant",
            content: "I'll help you read that file.",
            toolUses: [
              {
                name: "read_file",
                args: { path: "test.txt" },
                result: { ok: true, content: "file contents" },
              },
            ],
          },
        ],
      };

      const result = previewToChatMessages(preview);

      expect(result).toHaveLength(1);
      expect(result[0]?.toolUses).toHaveLength(1);
      expect(result[0]?.toolUses?.[0]?.name).toBe("read_file");
      expect(result[0]?.toolUses?.[0]?.result.ok).toBe(true);
    });

    it("handles messages without tool uses", () => {
      const preview: SessionTranscriptPreview = {
        sessionId: "test-session",
        messages: [
          {
            role: "user",
            content: "Simple question",
          },
        ],
      };

      const result = previewToChatMessages(preview);

      expect(result).toHaveLength(1);
      expect(result[0]).not.toHaveProperty("toolUses");
    });

    it("handles empty message list", () => {
      const preview: SessionTranscriptPreview = {
        sessionId: "test-session",
        messages: [],
      };

      const result = previewToChatMessages(preview);

      expect(result).toHaveLength(0);
    });
  });

  describe("resumedVisibleMessages", () => {
    it("generates resume info message followed by last 12 messages", () => {
      const preview: SessionTranscriptPreview = {
        sessionId: "abc-123-def",
        messages: Array.from({ length: 20 }, (_, i) => ({
          role: i % 2 === 0 ? "user" : "assistant",
          content: `Message ${i}`,
        })),
      };

      const result = resumedVisibleMessages("abc-123-def", preview, {
        turnCount: 10,
        totalCostUsd: 0.5234,
      });

      expect(result).toHaveLength(13); // 1 info + last 12 messages
      expect(result[0]?.role).toBe("assistant");
      expect(result[0]?.content).toContain("Resumed session");
      expect(result[0]?.content).toContain("abc-1");
      expect(result[0]?.content).toContain("10 turns");
      expect(result[0]?.content).toContain("$0.52");
    });

    it("handles sessions with fewer than 12 messages", () => {
      const preview: SessionTranscriptPreview = {
        sessionId: "xyz-789",
        messages: [
          { role: "user", content: "First" },
          { role: "assistant", content: "Second" },
        ],
      };

      const result = resumedVisibleMessages("xyz-789", preview, {
        turnCount: 1,
        totalCostUsd: 0.01,
      });

      expect(result).toHaveLength(3); // 1 info + 2 messages
      expect(result[0]?.content).toContain("showing the last 2 messages");
    });

    it("displays session ID truncated to 8 chars", () => {
      const preview: SessionTranscriptPreview = {
        sessionId: "very-long-session-id-that-should-be-truncated",
        messages: [],
      };

      const result = resumedVisibleMessages(
        "very-long-session-id-that-should-be-truncated",
        preview,
        { turnCount: 5, totalCostUsd: 0.1234 },
      );

      // sessionId.slice(0, 8) of "very-long-..." = "very-lon"
      expect(result[0]?.content).toContain("very-lon");
      expect(result[0]?.content).not.toContain("that-should");
    });

    it("formats cost with 2 decimal places", () => {
      const preview: SessionTranscriptPreview = {
        sessionId: "test",
        messages: [],
      };

      const result = resumedVisibleMessages("test", preview, {
        turnCount: 2,
        totalCostUsd: 1.23456,
      });

      expect(result[0]?.content).toMatch(/\$1\.23/);
    });
  });
});
