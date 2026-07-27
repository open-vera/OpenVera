import type { ChatSnapshot } from "@/stores/chat";
import type { ChatTab, Message } from "@/types";
import {
  normalizePartnerSessions,
  type PartnerTaskSnapshot,
  type PartnerWindowSnapshot,
} from "@/utils/partner-sessions";

export interface SessionSearchSource {
  key: string;
  windowId: string;
  tabId: string;
  title: string;
  updatedAt: number;
  messages: Message[];
  taskSnapshot?: PartnerTaskSnapshot;
  windowSnapshot?: PartnerWindowSnapshot;
}

export interface SessionSearchHit {
  key: string;
  source: SessionSearchSource;
  /** Matched message when query hits content; omitted for title-only / recent. */
  message?: Message;
  excerpt: string;
}

export interface CurrentWindowInput {
  windowId: string;
  chat: ChatSnapshot;
  preview: PartnerWindowSnapshot["preview"];
  updatedAt?: number;
}

function lastMessage(tab: ChatTab): Message | undefined {
  return [...tab.messages].reverse().find((message) => message.content.trim());
}

function sourceUpdatedAt(tab: ChatTab, fallback: number): number {
  return lastMessage(tab)?.timestamp ?? fallback;
}

function tabTitle(tab: ChatTab, fallback: string): string {
  return tab.title.trim() || fallback;
}

export function messageSearchText(message: Message): string {
  const toolCalls =
    message.toolCalls
      ?.map((toolCall) => `${toolCall.name} ${JSON.stringify(toolCall.input)}`)
      .join("\n") ?? "";
  const toolResults =
    message.toolResults?.map((result) => result.output).join("\n") ?? "";
  const attachments =
    message.attachments
      ?.map((attachment) => `${attachment.name} ${attachment.content ?? ""}`)
      .join("\n") ?? "";
  return [message.content, message.agentContent, toolCalls, toolResults, attachments]
    .filter(Boolean)
    .join("\n");
}

export function excerptFor(text: string, search: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "空消息";
  const index = normalized.toLowerCase().indexOf(search.toLowerCase());
  const start = index >= 0 ? Math.max(0, index - 44) : 0;
  const excerpt = normalized.slice(start, start + 150);
  return `${start > 0 ? "…" : ""}${excerpt}${start + 150 < normalized.length ? "…" : ""}`;
}

export function sourcePreview(source: SessionSearchSource): string {
  const message = [...source.messages].reverse().find((item) => item.content.trim());
  if (!message) return "空会话";
  return message.content.trim().replace(/\s+/g, " ").slice(0, 80);
}

/** Build searchable sources from Host/app-state sessions. */
export function buildSessionSearchSourcesFromAppSessions(
  sessions: Record<
    string,
    { id: string; title: string; messages: Message[]; updatedAt: number }
  >,
  current: CurrentWindowInput,
): SessionSearchSource[] {
  const fromHost = Object.values(sessions).map((session) => ({
    key: `host:${session.id}`,
    windowId: current.windowId,
    tabId: session.id,
    title: session.title.trim() || "未命名会话",
    updatedAt: session.updatedAt,
    messages: session.messages,
  }));
  const fromCurrent = current.chat.tabs
    .filter((tab) => tab.kind === "chat")
    .map((tab) => ({
      key: `window:${current.windowId}:${tab.id}`,
      windowId: current.windowId,
      tabId: tab.id,
      title: tabTitle(tab, "未命名会话"),
      updatedAt: sourceUpdatedAt(tab, current.updatedAt ?? Date.now()),
      messages: tab.messages,
    }));
  const unique = new Map<string, SessionSearchSource>();
  for (const source of [...fromHost, ...fromCurrent].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  )) {
    if (!unique.has(source.tabId)) unique.set(source.tabId, source);
  }
  return [...unique.values()];
}

/** @deprecated partner-sessions path removed — use buildSessionSearchSourcesFromAppSessions. */
export function buildSessionSearchSources(
  snapshot: unknown,
  current: CurrentWindowInput,
): SessionSearchSource[] {
  const normalized = normalizePartnerSessions(snapshot);
  normalized.windows[current.windowId] = {
    windowId: current.windowId,
    chat: current.chat,
    preview: current.preview,
    layout: { leftWidth: 240, previewWidth: 640 },
    updatedAt: current.updatedAt ?? Date.now(),
  };

  const taskSources = Object.values(normalized.tasks).flatMap((task) =>
    task.chat.tabs
      .filter((tab) => tab.kind === "chat")
      .map((tab) => ({
        key: `task:${task.taskId}:${tab.id}`,
        windowId: task.windowId,
        tabId: tab.id,
        title: task.title || tabTitle(tab, "未命名任务"),
        updatedAt: task.updatedAt,
        messages: tab.messages,
        taskSnapshot: task,
      })),
  );

  const windowSources = Object.values(normalized.windows).flatMap((windowSnapshot) =>
    windowSnapshot.chat.tabs
      .filter((tab) => tab.kind === "chat")
      .map((tab) => ({
        key: `window:${windowSnapshot.windowId}:${tab.id}`,
        windowId: windowSnapshot.windowId,
        tabId: tab.id,
        title: tabTitle(tab, "未命名会话"),
        updatedAt: sourceUpdatedAt(tab, windowSnapshot.updatedAt),
        messages: tab.messages,
        windowSnapshot,
      })),
  );

  const unique = new Map<string, SessionSearchSource>();
  for (const source of [...taskSources, ...windowSources].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  )) {
    const firstMessageId = source.messages[0]?.id ?? "";
    const key = `${source.windowId}:${source.tabId}:${firstMessageId}`;
    if (!unique.has(key)) unique.set(key, source);
  }
  return [...unique.values()];
}

/** Recent sessions (no query). */
export function recentSessionHits(
  sources: SessionSearchSource[],
  limit = 40,
): SessionSearchHit[] {
  return sources.slice(0, limit).map((source) => ({
    key: `recent:${source.key}`,
    source,
    excerpt: sourcePreview(source),
  }));
}

/**
 * Match sessions by title or message content.
 * Title matches yield one hit per session; content matches yield per-message hits.
 */
export function filterSessionHits(
  sources: SessionSearchSource[],
  query: string,
  limit = 40,
): SessionSearchHit[] {
  const search = query.trim().toLowerCase();
  if (!search) return recentSessionHits(sources, limit);

  const hits: SessionSearchHit[] = [];
  for (const source of sources) {
    if (hits.length >= limit) break;
    const titleMatch = source.title.toLowerCase().includes(search);
    const messageHits = source.messages.filter((message) =>
      messageSearchText(message).toLowerCase().includes(search),
    );

    if (titleMatch && messageHits.length === 0) {
      hits.push({
        key: `title:${source.key}`,
        source,
        excerpt: sourcePreview(source),
      });
      continue;
    }

    for (const message of messageHits) {
      if (hits.length >= limit) break;
      hits.push({
        key: `${source.key}:${message.id}`,
        source,
        message,
        excerpt: excerptFor(messageSearchText(message), search),
      });
    }
  }
  return hits;
}
