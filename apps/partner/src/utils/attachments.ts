import type { ChatAttachment, ChatAttachmentKind } from "@/types";

const MAX_INLINE_TEXT_CHARS = 120_000;
const MAX_INLINE_DATA_URL_BYTES = 1_500_000;

const TEXT_EXTENSIONS = new Set([
  "css",
  "csv",
  "html",
  "js",
  "json",
  "jsx",
  "log",
  "md",
  "py",
  "rs",
  "toml",
  "ts",
  "tsx",
  "txt",
  "vue",
  "xml",
  "yaml",
  "yml",
]);

function extensionFor(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function inferKind(file: File): ChatAttachmentKind {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("text/")) return "text";
  if (
    [
      "application/json",
      "application/javascript",
      "application/typescript",
      "application/xml",
      "application/x-yaml",
    ].includes(file.type)
  ) {
    return "text";
  }
  return TEXT_EXTENSIONS.has(extensionFor(file.name)) ? "text" : "binary";
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Failed to read file")));
    reader.readAsDataURL(file);
  });
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  const kb = size / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}

function fenceLanguage(attachment: ChatAttachment): string {
  return extensionFor(attachment.name).replace(/[^a-z0-9-]/g, "");
}

export async function createChatAttachment(file: File): Promise<ChatAttachment> {
  const kind = inferKind(file);
  const base = {
    id: crypto.randomUUID(),
    name: file.name || (kind === "image" ? "pasted-image.png" : "attachment"),
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    kind,
  };

  if (kind === "text") {
    const raw = await file.text();
    const truncated = raw.length > MAX_INLINE_TEXT_CHARS;
    return {
      ...base,
      content: truncated ? raw.slice(0, MAX_INLINE_TEXT_CHARS) : raw,
      truncated,
    };
  }

  if (file.size <= MAX_INLINE_DATA_URL_BYTES) {
    return {
      ...base,
      dataUrl: await readAsDataUrl(file),
    };
  }

  return base;
}

export async function createChatAttachments(files: Iterable<File>): Promise<ChatAttachment[]> {
  return Promise.all(Array.from(files, createChatAttachment));
}

export function attachmentLabel(attachment: ChatAttachment): string {
  return `${attachment.name} (${formatBytes(attachment.size)})`;
}

export function buildAgentMessageContent(text: string, attachments: ChatAttachment[]): string {
  const trimmed = text.trim();
  if (!attachments.length) return trimmed;

  const blocks = attachments.map((attachment, index) => {
    const header = [
      `Attachment ${index + 1}: ${attachment.name}`,
      `kind: ${attachment.kind}`,
      `mimeType: ${attachment.mimeType}`,
      `size: ${formatBytes(attachment.size)}`,
    ].join("\n");

    if (attachment.kind === "text" && attachment.content !== undefined) {
      const language = fenceLanguage(attachment);
      const suffix = attachment.truncated
        ? "\n\n[Note: file content was truncated before sending.]"
        : "";
      return `${header}\ncontent:\n\`\`\`${language}\n${attachment.content}\n\`\`\`${suffix}`;
    }

    if (attachment.dataUrl) {
      return `${header}\ndataUrl:\n${attachment.dataUrl}`;
    }

    return `${header}\n[Content not inlined because the file is too large or unsupported.]`;
  });

  return [
    trimmed || "请查看附件内容。",
    "The user attached the following files. Use them as context for the request:",
    ...blocks,
  ].join("\n\n");
}
