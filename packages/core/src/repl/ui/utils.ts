import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../../session/index.js";
import type { ChatMessage } from "./types.js";

export function maybeWriteGitBranch(store: SessionStore, cwd: string): void {
  try {
    const branch = readFileSync(join(cwd, ".git", "HEAD"), "utf8")
      .trim()
      .replace(/^ref: refs\/heads\//, "");
    if (branch) store.writeGitBranch(branch);
  } catch {
    // Git metadata is opportunistic; keep session startup fast and quiet.
  }
}

export function previewToChatMessages(
  preview: ReturnType<typeof SessionStore.loadTranscriptPreview>,
): ChatMessage[] {
  return preview.messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.toolUses?.length
      ? {
          toolUses: message.toolUses.map((toolUse) => ({
            name: toolUse.name,
            args: toolUse.args,
            result: { ok: toolUse.result.ok, content: toolUse.result.content },
          })),
        }
      : {}),
  }));
}

export function resumedVisibleMessages(
  sessionId: string,
  preview: ReturnType<typeof SessionStore.loadTranscriptPreview>,
  loaded: { turnCount: number; totalCostUsd: number },
): ChatMessage[] {
  const recentMessages = previewToChatMessages(preview).slice(-12);
  return [
    {
      role: "assistant",
      content: `Resumed session ${sessionId.slice(0, 8)} — showing the last ${recentMessages.length} messages from ${loaded.turnCount} turns, $${loaded.totalCostUsd.toFixed(4)} spent.`,
    },
    ...recentMessages,
  ];
}
