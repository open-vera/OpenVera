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
