export type {
  ChannelType,
  ChannelAttachment,
  ChannelMessage,
  ConnectionState,
  ChannelStatus,
  MessageCallback,
  SendMessageOptions,
  HistoryOptions,
  ChannelAdapter,
  GatewayConfig,
  GatewayEvent,
  GatewayEventCallback,
} from "./types.js";

export {
  ChannelError,
  ChannelConnectionError,
  ChannelSendError,
  ChannelTimeoutError,
  ChannelNotConnectedError,
  ChannelNotFoundError,
} from "./types.js";

export { ChannelGateway } from "./gateway.js";
export type { SessionBinding, MessageHandler } from "./gateway.js";

export { CliChannelAdapter } from "./cli-channel.js";
export type { CliChannelConfig } from "./cli-channel.js";

export { ApiChannelAdapter } from "./api-channel.js";
export type { ApiChannelConfig } from "./api-channel.js";

export { WebhookChannelAdapter } from "./webhook-channel.js";
export type {
  WebhookChannelConfig,
  WebhookSignatureConfig,
  WebhookVerifyStrategy,
  WebhookPayloadParser,
} from "./webhook-channel.js";

export { FeishuChannelAdapter } from "./feishu-channel.js";
export type { FeishuChannelConfig } from "./feishu-channel.js";

export { WeComChannelAdapter } from "./wecom-channel.js";
export type { WeComChannelConfig } from "./wecom-channel.js";

export { TelegramChannelAdapter } from "./telegram-channel.js";
export type { TelegramChannelConfig } from "./telegram-channel.js";

export { DiscordChannelAdapter } from "./discord-channel.js";
export type { DiscordChannelConfig } from "./discord-channel.js";

export {
  ChannelPluginRegistry,
  PluginAlreadyRegisteredError,
  PluginNotFoundError,
  AdapterAlreadyLoadedError,
  AdapterNotLoadedError,
} from "./plugin-registry.js";
export type {
  ChannelPluginMeta,
  AdapterFactory,
  ChannelPlugin,
  LoadedAdapter,
} from "./plugin-registry.js";
