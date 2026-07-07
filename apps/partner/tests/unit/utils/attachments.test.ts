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
