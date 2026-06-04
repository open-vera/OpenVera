export type ConversationRole = "user" | "assistant" | "system";

export interface ConversationMessage {
  id: string;
  role: ConversationRole;
  content: string;
  createdAt: string;
}

export interface Conversation {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ConversationMessage[];
}

const conversations = new Map<string, Conversation>();

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function listConversations(projectId?: string): Conversation[] {
  const items = Array.from(conversations.values());
  const filtered = projectId ? items.filter((item) => item.projectId === projectId) : items;
  return filtered.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export function createConversation(projectId: string, title?: string): Conversation {
  const now = new Date().toISOString();
  const conversation: Conversation = {
    id: uniqueId("conv"),
    projectId,
    title: title?.trim() || "新对话",
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  conversations.set(conversation.id, conversation);
  return conversation;
}

export function getConversation(conversationId: string): Conversation | undefined {
  return conversations.get(conversationId);
}

export function appendMessage(
  conversationId: string,
  role: ConversationRole,
  content: string,
): ConversationMessage | undefined {
  const conversation = conversations.get(conversationId);
  if (!conversation) return undefined;

  const message: ConversationMessage = {
    id: uniqueId("msg"),
    role,
    content: content.trim(),
    createdAt: new Date().toISOString(),
  };
  conversation.messages.push(message);
  conversation.updatedAt = message.createdAt;
  if (conversation.messages.length === 1 && role === "user") {
    conversation.title = content.trim().slice(0, 48) || conversation.title;
  }
  conversations.set(conversationId, conversation);
  return message;
}

export function appendAssistantMessage(conversationId: string, content: string): ConversationMessage | undefined {
  return appendMessage(conversationId, "assistant", content);
}

export function resetConversations(): void {
  conversations.clear();
}
