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
