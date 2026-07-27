import { describe, expect, it } from "vitest";
import type { ChatAttachment } from "@/types";
import {
  attachmentDisplayName,
  attachmentLabel,
  buildAgentMessageContent,
  compressImageToDataUrl,
  createPathAttachment,
  createSelectionAttachment,
  imagePreviewDimensions,
  MAX_IMAGE_PREVIEW_EDGE,
  mergeChatAttachments,
} from "@/utils/attachments";

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

  it("formats path and selection refs for the agent while keeping chip labels short", () => {
    const path = createPathAttachment("/workspace/apps/partner/README.md", false);
    const folder = createPathAttachment("/workspace/apps", true);
    const selection = createSelectionAttachment({
      path: "/workspace/CLAUDE.md",
      name: "CLAUDE.md",
      content: "| `.gemini/` | Gemini |",
      startLine: 12,
      endLine: 13,
    });

    expect(attachmentDisplayName(selection)).toBe("CLAUDE.md:12-13");
    expect(path.kind).toBe("path");
    expect(folder.kind).toBe("folder");

    const message = buildAgentMessageContent("看看这些", [path, folder, selection]);
    expect(message).toContain("path: /workspace/apps/partner/README.md");
    expect(message).toContain("Path reference");
    expect(message).toContain("lines: 12-13");
    expect(message).toContain("| `.gemini/` | Gemini |");
  });

  it("dedupes path attachments when merging", () => {
    const a = createPathAttachment("/workspace/a.ts", false);
    const b = createPathAttachment("/workspace/a.ts", false);
    const merged = mergeChatAttachments([a], [b, createPathAttachment("/workspace/b.ts", false)]);
    expect(merged).toHaveLength(2);
  });

  it("formats attachment labels with readable sizes", () => {
    const image: ChatAttachment = {
      id: "a1",
      name: "screenshot.png",
      mimeType: "image/png",
      size: 2048,
      kind: "image",
      dataUrl: "data:image/png;base64,abc",
    };
    const file: ChatAttachment = {
      id: "a2",
      name: "notes.txt",
      mimeType: "text/plain",
      size: 2048,
      kind: "text",
      content: "hi",
    };

    expect(attachmentLabel(image)).toBe("点击查看大图 · 2.0 KB");
    expect(attachmentLabel(image, "en")).toBe("Click to preview · 2.0 KB");
    expect(attachmentLabel(file)).toBe("notes.txt (2.0 KB)");
  });

  it("scales oversized image dimensions down to the preview edge", () => {
    expect(imagePreviewDimensions(4096, 2048)).toEqual({
      width: MAX_IMAGE_PREVIEW_EDGE,
      height: 1024,
      scale: 0.5,
    });
    expect(imagePreviewDimensions(800, 600)).toEqual({
      width: 800,
      height: 600,
      scale: 1,
    });
  });

  it("notes when an image attachment was compressed before sending", () => {
    const attachment: ChatAttachment = {
      id: "a1",
      name: "image.png",
      mimeType: "image/png",
      size: 3_000_000,
      kind: "image",
      dataUrl: "data:image/jpeg;base64,abc",
      truncated: true,
    };

    const message = buildAgentMessageContent("看看这张图", [attachment]);
    expect(message).toContain("data:image/jpeg;base64,abc");
    expect(message).toContain("image was compressed/resized before sending");
  });

  it("skips image compression when Canvas is unavailable (Node tests)", async () => {
    const file = new File([new Uint8Array(2_000_000)], "image.png", {
      type: "image/png",
    });
    await expect(compressImageToDataUrl(file)).resolves.toBeNull();
  });
});
