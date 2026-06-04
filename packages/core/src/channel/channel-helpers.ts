import type {
  ChannelAttachment,
  ChannelMessage,
  ChannelType,
  HistoryOptions,
  MessageCallback,
  SendMessageOptions,
} from "./types.js";

export function subscribeMessage(
  callbacks: MessageCallback[],
  callback: MessageCallback
): () => void {
  callbacks.push(callback);
  return () => {
    const idx = callbacks.indexOf(callback);
    if (idx >= 0) callbacks.splice(idx, 1);
  };
}

export async function filterChannelHistory(
  history: ChannelMessage[],
  options?: HistoryOptions
): Promise<ChannelMessage[]> {
  let result = [...history];

  if (options?.after) {
    result = result.filter((m) => m.timestamp > options.after!);
  }
  if (options?.before) {
    result = result.filter((m) => m.timestamp < options.before!);
  }
  if (options?.senderId) {
    result = result.filter((m) => m.senderId === options.senderId);
  }
  if (options?.limit) {
    result = result.slice(0, options.limit);
  }

  return result;
}

export function appendBotMessage(
  history: ChannelMessage[],
  channelType: ChannelType,
  options: SendMessageOptions,
  generateId: () => string,
  overrides?: { id?: string; timestamp?: string }
): ChannelMessage {
  const message: ChannelMessage = {
    id: overrides?.id ?? generateId(),
    channelType,
    senderId: "bot",
    content: options.content,
    attachments: (options.attachments ?? []) as ChannelAttachment[],
    replyTo: options.replyTo,
    timestamp: overrides?.timestamp ?? new Date().toISOString(),
  };
  history.push(message);
  return message;
}
