import { pathInfo } from "@/bridge";
import type { ChatAttachment, ChatAttachmentKind } from "@/types";
import {
  basenamePath,
  type PartnerPathDragItem,
  type PartnerSelectionPayload,
} from "@/utils/partner-dnd";

const MAX_INLINE_TEXT_CHARS = 120_000;
/** Max original file size (bytes) / compressed data-URL length for inline images. */
export const MAX_INLINE_DATA_URL_BYTES = 1_500_000;
/** Longest edge when compressing oversized chat images for preview + agent inline. */
export const MAX_IMAGE_PREVIEW_EDGE = 2048;

export interface OpenFileContext {
  activeFilePath?: string | null;
  openFilePaths?: string[];
  projectRoot?: string;
}

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
  // A leading-dot config file (.prettierrc, .npmrc) has no extension; splitting
  // on "." would report the whole name and misclassify it as binary.
  if (name.startsWith(".") && !name.slice(1).includes(".")) return "";
  return name.split(".").pop()?.toLowerCase() ?? "";
}

/** Leading-dot tool configs are text even though they carry no extension. */
function isDotfileConfig(name: string): boolean {
  return name.startsWith(".") && !name.slice(1).includes(".");
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
  if (isDotfileConfig(file.name)) return "text";
  return TEXT_EXTENSIONS.has(extensionFor(file.name)) ? "text" : "binary";
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error("Failed to read file"))
    );
    reader.readAsDataURL(file);
  });
}

/** Scale so the longest edge fits `maxEdge` (never upscale). */
export function imagePreviewDimensions(
  width: number,
  height: number,
  maxEdge: number = MAX_IMAGE_PREVIEW_EDGE
): { width: number; height: number; scale: number } {
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  const scale = Math.min(1, maxEdge / Math.max(safeWidth, safeHeight));
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
    scale,
  };
}

interface DecodedImageSource {
  width: number;
  height: number;
  draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void;
  close: () => void;
}

async function decodeImageSource(file: File): Promise<DecodedImageSource> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    return {
      width: bitmap.width,
      height: bitmap.height,
      draw: (ctx, width, height) => ctx.drawImage(bitmap, 0, 0, width, height),
      close: () => bitmap.close(),
    };
  }

  const dataUrl = await readAsDataUrl(file);
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("Invalid image file"));
    element.src = dataUrl;
  });
  return {
    width: image.naturalWidth || image.width,
    height: image.naturalHeight || image.height,
    draw: (ctx, width, height) => ctx.drawImage(image, 0, 0, width, height),
    close: () => undefined,
  };
}

/**
 * Downscale / re-encode an oversized image into a data URL under `maxBytes`.
 * Returns null when Canvas is unavailable or compression cannot meet the budget.
 */
export async function compressImageToDataUrl(
  file: File,
  maxBytes: number = MAX_INLINE_DATA_URL_BYTES,
  maxEdge: number = MAX_IMAGE_PREVIEW_EDGE
): Promise<string | null> {
  if (typeof document === "undefined") return null;

  let source: DecodedImageSource | null = null;
  try {
    source = await decodeImageSource(file);
    let { width, height } = imagePreviewDimensions(
      source.width,
      source.height,
      maxEdge
    );

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    const encode = (w: number, h: number, quality: number): string => {
      canvas.width = w;
      canvas.height = h;
      source!.draw(ctx, w, h);
      return canvas.toDataURL("image/jpeg", quality);
    };

    let quality = 0.85;
    let dataUrl = encode(width, height, quality);
    while (dataUrl.length > maxBytes && quality > 0.5) {
      quality -= 0.05;
      dataUrl = encode(width, height, quality);
    }

    while (dataUrl.length > maxBytes && Math.max(width, height) > 512) {
      width = Math.max(1, Math.round(width * 0.75));
      height = Math.max(1, Math.round(height * 0.75));
      dataUrl = encode(width, height, 0.7);
    }

    return dataUrl.length <= maxBytes ? dataUrl : null;
  } catch {
    return null;
  } finally {
    source?.close();
  }
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

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths.map((path) => path.trim()).filter(Boolean)));
}

function displayPath(path: string, projectRoot?: string): string {
  if (!projectRoot) return path;
  const normalizedRoot = projectRoot.endsWith("/")
    ? projectRoot
    : `${projectRoot}/`;
  return path.startsWith(normalizedRoot)
    ? path.slice(normalizedRoot.length)
    : path;
}

function formatOpenFileContext(context?: OpenFileContext): string | null {
  const openFilePaths = uniquePaths(context?.openFilePaths ?? []);
  const activeFilePath = context?.activeFilePath?.trim();
  const paths = uniquePaths([
    ...(activeFilePath ? [activeFilePath] : []),
    ...openFilePaths,
  ]);
  if (!paths.length) return null;

  const activeLine = activeFilePath
    ? `Active file: ${displayPath(activeFilePath, context?.projectRoot)}`
    : null;
  const openLines = paths.map(
    (path) => `- ${displayPath(path, context?.projectRoot)}`
  );

  return [
    "The following files are already open in the workspace. Their contents are not inlined; use these paths as context hints when relevant:",
    activeLine,
    "Open files:",
    ...openLines,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export async function createChatAttachment(
  file: File
): Promise<ChatAttachment> {
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

  if (kind === "image") {
    const compressed = await compressImageToDataUrl(file);
    if (compressed) {
      return {
        ...base,
        dataUrl: compressed,
        truncated: true,
      };
    }
  }

  return base;
}

export async function createChatAttachments(
  files: Iterable<File>
): Promise<ChatAttachment[]> {
  return Promise.all(Array.from(files, createChatAttachment));
}

export function createPathAttachment(
  path: string,
  isDir: boolean
): ChatAttachment {
  const name = basenamePath(path);
  return {
    id: crypto.randomUUID(),
    name,
    mimeType: isDir ? "inode/directory" : "text/uri-list",
    size: 0,
    kind: isDir ? "folder" : "path",
    path,
  };
}

export function createSelectionAttachment(
  payload: PartnerSelectionPayload
): ChatAttachment {
  const raw = payload.content;
  const truncated = raw.length > MAX_INLINE_TEXT_CHARS;
  return {
    id: crypto.randomUUID(),
    name: payload.name,
    mimeType: "text/plain",
    size: new TextEncoder().encode(raw).length,
    kind: "selection",
    path: payload.path,
    startLine: payload.startLine,
    endLine: payload.endLine,
    content: truncated ? raw.slice(0, MAX_INLINE_TEXT_CHARS) : raw,
    truncated,
  };
}

export async function createChatAttachmentsFromPaths(
  paths: string[]
): Promise<ChatAttachment[]> {
  const unique = uniquePaths(paths);
  const attachments = await Promise.all(
    unique.map(async (path) => {
      try {
        const info = await pathInfo(path);
        return createPathAttachment(info.path, info.isDir);
      } catch {
        return createPathAttachment(path, false);
      }
    })
  );
  return attachments;
}

export function createChatAttachmentsFromDragItems(
  items: PartnerPathDragItem[]
): ChatAttachment[] {
  const seen = new Set<string>();
  const attachments: ChatAttachment[] = [];
  for (const item of items) {
    const path = item.path.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    attachments.push(createPathAttachment(path, item.isDir));
  }
  return attachments;
}

export function mergeChatAttachments(
  existing: ChatAttachment[],
  incoming: ChatAttachment[]
): ChatAttachment[] {
  const seenPaths = new Set(
    existing
      .map((item) => item.path)
      .filter((path): path is string => Boolean(path))
  );
  const seenSelectionKeys = new Set(
    existing
      .filter((item) => item.kind === "selection")
      .map(
        (item) =>
          `${item.path ?? ""}:${item.startLine ?? 0}:${item.endLine ?? 0}:${item.content ?? ""}`
      )
  );

  const next = [...existing];
  for (const item of incoming) {
    if (item.kind === "selection") {
      const key = `${item.path ?? ""}:${item.startLine ?? 0}:${item.endLine ?? 0}:${item.content ?? ""}`;
      if (seenSelectionKeys.has(key)) continue;
      seenSelectionKeys.add(key);
      next.push(item);
      continue;
    }
    if (item.path) {
      if (seenPaths.has(item.path)) continue;
      seenPaths.add(item.path);
      next.push(item);
      continue;
    }
    next.push(item);
  }
  return next;
}

export function attachmentChipKind(attachment: ChatAttachment): string {
  switch (attachment.kind) {
    case "image":
      return "IMG";
    case "folder":
      return "DIR";
    case "path":
      return "FILE";
    case "selection":
      return "SEL";
    case "text":
      return "TXT";
    default:
      return "FILE";
  }
}

export function attachmentDisplayName(attachment: ChatAttachment): string {
  if (attachment.kind === "selection") {
    const start = attachment.startLine ?? 1;
    const end = attachment.endLine ?? start;
    return start === end
      ? `${attachment.name}:${start}`
      : `${attachment.name}:${start}-${end}`;
  }
  return attachment.name;
}

export function attachmentLabel(
  attachment: ChatAttachment,
  locale: "zh" | "en" = "zh"
): string {
  if (attachment.kind === "image") {
    const size = formatBytes(attachment.size);
    return locale === "en"
      ? `Click to preview · ${size}`
      : `点击查看大图 · ${size}`;
  }
  if (attachment.kind === "selection") {
    const range =
      attachment.startLine && attachment.endLine
        ? attachment.startLine === attachment.endLine
          ? `L${attachment.startLine}`
          : `L${attachment.startLine}-L${attachment.endLine}`
        : "";
    const path = attachment.path ?? attachment.name;
    return range ? `${path} · ${range}` : path;
  }
  if (attachment.kind === "path" || attachment.kind === "folder") {
    return attachment.path ?? attachment.name;
  }
  return `${attachment.name} (${formatBytes(attachment.size)})`;
}

export function buildAgentMessageContent(
  text: string,
  attachments: ChatAttachment[],
  openFileContext?: OpenFileContext
): string {
  const trimmed = text.trim();
  const contextBlock = formatOpenFileContext(openFileContext);
  if (!attachments.length && !contextBlock) return trimmed;

  const blocks = attachments.map((attachment, index) => {
    const header = [
      `Attachment ${index + 1}: ${attachment.name}`,
      `kind: ${attachment.kind}`,
      `mimeType: ${attachment.mimeType}`,
      `size: ${formatBytes(attachment.size)}`,
      attachment.path ? `path: ${attachment.path}` : null,
      attachment.kind === "selection" &&
      attachment.startLine &&
      attachment.endLine
        ? `lines: ${attachment.startLine}-${attachment.endLine}`
        : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");

    if (attachment.kind === "selection" && attachment.content !== undefined) {
      const language = fenceLanguage(attachment);
      const suffix = attachment.truncated
        ? "\n\n[Note: selection content was truncated before sending.]"
        : "";
      return `${header}\ncontent:\n\`\`\`${language}\n${attachment.content}\n\`\`\`${suffix}`;
    }

    if (attachment.kind === "path" || attachment.kind === "folder") {
      return `${header}\n[Path reference — contents are not inlined; use read_file / list_dir when needed.]`;
    }

    if (attachment.kind === "text" && attachment.content !== undefined) {
      const language = fenceLanguage(attachment);
      const suffix = attachment.truncated
        ? "\n\n[Note: file content was truncated before sending.]"
        : "";
      return `${header}\ncontent:\n\`\`\`${language}\n${attachment.content}\n\`\`\`${suffix}`;
    }

    if (attachment.dataUrl) {
      const suffix = attachment.truncated
        ? "\n\n[Note: image was compressed/resized before sending.]"
        : "";
      return `${header}\ndataUrl:\n${attachment.dataUrl}${suffix}`;
    }

    return `${header}\n[Content not inlined because the file is too large or unsupported.]`;
  });

  return [
    trimmed || "请查看附件内容。",
    contextBlock,
    attachments.length
      ? "The user attached the following context. Use it for the request:"
      : null,
    ...blocks,
  ]
    .filter((block): block is string => Boolean(block))
    .join("\n\n");
}
