import type { Message } from "@/types";

export type MessageAnchor = {
  id: string;
  preview: string;
};

const DEFAULT_PREVIEW_MAX = 220;
const ASSISTANT_PREVIEW_MAX = 160;

/** Multi-line preview text for message-anchor hover cards. */
export function formatAnchorPreview(
  content: string,
  max = DEFAULT_PREVIEW_MAX,
): string {
  const normalized = content
    .trim()
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  if (!normalized) return "(空消息)";
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

/** @deprecated Use {@link formatAnchorPreview}. */
export function truncateAnchorPreview(content: string, max = 42): string {
  const normalized = content.trim().replace(/\s+/g, " ");
  if (!normalized) return "(空消息)";
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

function nextAssistantReply(
  messages: readonly Message[],
  userIndex: number,
): string {
  for (let index = userIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "user") break;
    if (message.role === "assistant" && message.content.trim()) {
      return message.content;
    }
  }
  return "";
}

/** Build clickable anchors for user utterances in the chat rail. */
export function buildUserMessageAnchors(messages: readonly Message[]): MessageAnchor[] {
  const anchors: MessageAnchor[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.role !== "user") continue;

    const userText = message.content.trim() || "(空消息)";
    const reply = nextAssistantReply(messages, index);
    const preview = reply
      ? formatAnchorPreview(
          `${userText}\n\n${formatAnchorPreview(reply, ASSISTANT_PREVIEW_MAX)}`,
        )
      : formatAnchorPreview(userText);

    anchors.push({ id: message.id, preview });
  }
  return anchors;
}
