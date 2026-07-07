import { describe, expect, it } from "vitest";
import type { ChatAttachment } from "@/types";
import { attachmentLabel, buildAgentMessageContent } from "@/utils/attachments";

describe("attachment utilities", () => {
  it("formats text attachments into agent message content", () => {
    const attachment: ChatAttachment = {
      id: "a1",
      name: "notes.md",
      mimeType: "text/markdown",
      size: 12,
      kind: "text",
      content: "# Hello",
    };

    const message = buildAgentMessageContent("Summarize this", [attachment]);

    expect(message).toContain("Summarize this");
    expect(message).toContain("Attachment 1: notes.md");
    expect(message).toContain("```md\n# Hello\n```");
  });

  it("keeps oversized binary attachments as metadata", () => {
    const attachment: ChatAttachment = {
      id: "a1",
      name: "archive.zip",
      mimeType: "application/zip",
      size: 3_000_000,
      kind: "binary",
    };

    const message = buildAgentMessageContent("", [attachment]);

    expect(message).toContain("请查看附件内容。");
    expect(message).toContain("archive.zip");
    expect(message).toContain("Content not inlined");
  });

  it("adds open file paths as lightweight agent context", () => {
    const message = buildAgentMessageContent("Explain this", [], {
      activeFilePath: "/workspace/project/src/App.vue",
      openFilePaths: [
        "/workspace/project/src/App.vue",
        "/workspace/project/src/stores/chat.ts",
      ],
      projectRoot: "/workspace/project",
    });

    expect(message).toContain("Explain this");
    expect(message).toContain("Active file: src/App.vue");
    expect(message).toContain("- src/App.vue");
    expect(message).toContain("- src/stores/chat.ts");
    expect(message).toContain("Their contents are not inlined");
    expect(message).not.toContain("/workspace/project/src/App.vue");
  });

  it("formats attachment labels with readable sizes", () => {
    const attachment: ChatAttachment = {
      id: "a1",
      name: "screenshot.png",
      mimeType: "image/png",
      size: 2048,
      kind: "image",
      dataUrl: "data:image/png;base64,abc",
    };

    expect(attachmentLabel(attachment)).toBe("screenshot.png (2.0 KB)");
  });
});
