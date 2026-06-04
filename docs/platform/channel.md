# Channel System

> This document describes OpenVera's multi-platform messaging channel abstraction layer, including the unified `ChannelAdapter` interface, Gateway routing mechanism, implemented channels, and how to develop new channel adapters.

## Overview

The Channel system provides a unified messaging abstraction that allows agents to interact with users through multiple platforms: CLI, HTTP API, Feishu (Lark), Discord, WeCom, Slack, Telegram, WhatsApp, and more. Core design principles:

- **Unified interface**: All platforms implement the same `ChannelAdapter` interface
- **Gateway routing**: `ChannelGateway` manages the lifecycle of multiple channels and routes messages to handlers uniformly
- **Session binding**: Supports binding agent sessions to specific channels for context association
- **Extensible**: Interface-based plugin design; adding a new platform only requires implementing `ChannelAdapter`

Core code is located in `packages/core/src/channel/`.

## Architecture

```
Agent Loop
     <->  Message Handlers
ChannelGateway
  +-- CLI Adapter      (REPL/pipe)
  +-- API Adapter      (REST + WebSocket)
  +-- Discord Adapter  (Gateway WebSocket)
  +-- Feishu Adapter   (Webhook)
  +-- ...more
       Session Bindings
```

- **ChannelAdapter**: Single-platform connection, send/receive implementation
- **ChannelGateway**: Manages multiple adapters, message routing, session binding, event notifications
- **SessionBinding**: Associates a session ID with a channel (`{ sessionId, channelName, boundAt, metadata }`)

## ChannelAdapter Interface

All channel adapters must implement the following interface (defined in `types.ts`):

```typescript
interface ChannelAdapter {
  readonly name: string;                   // Unique name, e.g. "cli", "feishu"
  readonly channelType: ChannelType;       // "cli" | "api" | "webhook" | "feishu" | "wecom" | "telegram" | "discord" | "slack" | "whatsapp" | "custom"
  readonly state: ConnectionState;         // "disconnected" | "connecting" | "connected" | "error"

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): ChannelStatus;              // { state, message?, changedAt, sentCount, receivedCount }

  sendMessage(options: SendMessageOptions): Promise<ChannelMessage>;
  onMessage(callback: MessageCallback): () => void;   // Returns unsubscribe function
  getHistory(options?: HistoryOptions): Promise<ChannelMessage[]>;
}
```

### Unified Message Format

All channel messages are normalized to `ChannelMessage`:

```typescript
interface ChannelMessage {
  id: string;                          // Unique message ID
  channelType: ChannelType;            // Source platform
  senderId: string;                    // Sender identifier
  senderName?: string;                 // Sender display name
  content: string;                     // Text content
  attachments: ChannelAttachment[];    // { type, url, name?, mimeType?, sizeBytes? }
  replyTo?: string;                    // ID of the message being replied to
  timestamp: string;                   // ISO timestamp
  raw?: unknown;                       // Platform-specific raw data
}
```

### Send Options

```typescript
interface SendMessageOptions {
  content: string;
  attachments?: ChannelAttachment[];
  replyTo?: string;
  channelOptions?: Record<string, unknown>;  // Platform-specific params (e.g. Discord channelId, Feishu receiveId)
}
```

### Error Types

```typescript
class ChannelError extends Error { code: string }               // Base class
class ChannelConnectionError extends ChannelError               // CHANNEL_CONNECTION
class ChannelSendError extends ChannelError                     // CHANNEL_SEND
class ChannelTimeoutError extends ChannelError                  // CHANNEL_TIMEOUT
class ChannelNotConnectedError extends ChannelError             // CHANNEL_NOT_CONNECTED
class ChannelNotFoundError extends ChannelError                 // CHANNEL_NOT_FOUND
```

## ChannelGateway

`ChannelGateway` is the central dispatcher for the channel system. Default configuration:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `maxConnections` | 10 | Maximum concurrent connections |
| `autoReconnect` | false | Whether to auto-reconnect |
| `reconnectIntervalMs` | 5000 | Reconnect interval |
| `maxReconnectAttempts` | 3 | Maximum retry attempts |

### Adapter Management

```typescript
const gateway = new ChannelGateway({ autoReconnect: true });

gateway.addAdapter("cli", new CliChannelAdapter());
gateway.addAdapter("discord", new DiscordChannelAdapter({ botToken: "..." }));

await gateway.connectAll();       // Connect all channels in parallel, auto-retry failures
gateway.listAdapters();          // [{ name, state }]
gateway.removeAdapter("discord"); // Remove and clean up subscriptions and session bindings
await gateway.disconnectAll();
```

### Message Dispatch Flow

```
External message arrives -> ChannelAdapter.onMessage cb
  -> Gateway.dispatchMessage(msg, channelName)
    -> emitEvent("message_received")
    -> Iterate messageHandlers, call each one
```

Registering a handler:

```typescript
const unsub = gateway.onMessage(async (message, channelName) => {
  // message: ChannelMessage
  // channelName: string (e.g. "discord", "feishu")
  const response = await agent.handle(message.content);
  await gateway.sendMessage(channelName, {
    content: response,
    channelOptions: { /* platform-specific params */ },
  });
});
```

### Session Binding

```typescript
gateway.bindSession("feishu", sessionId, { chatId: "xxx" });
gateway.getSession(sessionId);
gateway.getSessionsForChannel("feishu");
gateway.unbindSession(sessionId);
```

### Event System

```typescript
gateway.onEvent((event) => {
  // event.type:
  // "channel_connected" | "channel_disconnected" | "channel_error"
  // | "message_received" | "message_sent" | "reconnecting"
});
```

## Implemented Channels

### CLI Channel (CliChannelAdapter)

The most basic channel implementation. Configuration:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `mode` | `"interactive"` | `"interactive"` (REPL) / `"pipe"` (stdin) / `"non-interactive"` |
| `prompt` | `"> "` | REPL prompt |
| `input` | `process.stdin` | Custom input stream |
| `output` | `process.stdout` | Custom output stream |
| `senderId` | `"cli-user"` | Sender ID |

**interactive** mode uses `readline` for line-by-line reading; **pipe** mode treats all stdin as a single message; **non-interactive** mode accepts input via `processInput(input)`.

### HTTP API Channel (ApiChannelAdapter)

REST API + WebSocket. Configuration:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `host` | `"0.0.0.0"` | Bind address |
| `port` | Auto | Listening port |
| `apiKey` | None | API key authentication |
| `maxBodyBytes` | 1MB | Max request body size |

REST endpoints: `GET /status`, `GET /messages` (supports `limit/after/before/senderId` params), `POST /messages` (body: `{ content, senderId? }`).

WebSocket implements a minimal RFC 6455 server, authenticated via `?token=`. Message format: client sends `{ type: "message", content }` or `{ type: "ping" }`; server replies with `{ type: "message", data }`, `{ type: "ack" }`, or `{ type: "pong" }`.

### Discord Channel (DiscordChannelAdapter)

Bot implementation based on Discord Gateway WebSocket (v10) + REST API.

Core mechanisms:
- WebSocket Gateway connection with jitter-based anti-thundering-herd heartbeat and zombie connection detection
- Exponential backoff reconnection (1s, 2s, 4s, 8s, ... max 30s)
- Supports Resume (session recovery after disconnect)
- Auto-filtering of the bot's own messages

Sending messages requires specifying the target channel via `channelOptions.channelId`:

```typescript
await gateway.sendMessage("discord", {
  content: "Hello!",
  channelOptions: {
    channelId: "123456789",
    embeds: [{ title: "Result", description: "..." }],
  },
});
```

### Feishu / Lark Channel (FeishuChannelAdapter)

Bot implementation based on Feishu Open Platform Webhooks.

Core mechanisms:
- `tenant_access_token` auto-refresh (60s buffer, concurrent deduplication)
- Supports v2 (`im.message.receive_v1`) and v1 event schemas
- URL verification (`url_verification` challenge) handled automatically
- Supports text / post / image / file message types
- Sending messages requires `channelOptions.receiveId` + `receiveIdType`

### Other Implemented Channels

| File | Channel | Protocol |
|------|---------|----------|
| `wecom-channel.ts` | WeCom (WeChat Work) | Webhook |
| `telegram-channel.ts` | Telegram | Bot API |
| `slack-channel.ts` | Slack | Bot API |
| `whatsapp-channel.ts` | WhatsApp | Business API |
| `webhook-channel.ts` | Generic Webhook | Configurable signature verification |

## Channel Lifecycle

Full flow using Feishu as an example:

1. **Register**: `gateway.addAdapter("feishu", adapter)`
2. **Connect**: Fetch `tenant_access_token` to validate credentials, start HTTP server, emit `"channel_connected"`
3. **Receive message**: Feishu POST webhook -> adapter parses event body -> `ChannelMessage` -> `onMessage` callbacks -> `gateway.dispatchMessage()` -> emit `"message_received"` -> agent handler
4. **Send response**: `gateway.sendMessage("feishu", {content, channelOptions})` -> call Feishu Open API -> emit `"message_sent"`
5. **Disconnect**: Shut down HTTP server, clean up token, emit `"channel_disconnected"`

## Implementing a New Channel Adapter

Using the webhook channel type as a template, follow these four steps:

### 1. Define Configuration

```typescript
interface MyChannelConfig {
  apiKey: string;
  host?: string;
  port?: number;
  path?: string;          // Default "/my-channel/webhook"
}
```

### 2. Implement ChannelAdapter

Skeleton code:

```typescript
export class MyChannelAdapter implements ChannelAdapter {
  readonly name = "my-channel";
  readonly channelType = "custom" as const;

  private _state: ConnectionState = "disconnected";
  private callbacks: MessageCallback[] = [];
  private history: ChannelMessage[] = [];
  private server: Server | null = null;
  private sentCount = 0;
  private receivedCount = 0;
  private stateChangedAt = new Date().toISOString();

  constructor(private config: MyChannelConfig) {}

  get state() { return this._state; }

  async connect(): Promise<void> {
    this.setState("connecting");
    // Start HTTP server
    this.server = createServer(async (req, res) => {
      const body = await readBody(req);
      const message = this.convertToChannelMessage(body);
      this.history.push(message);
      this.receivedCount++;
      for (const cb of this.callbacks) await cb(message);
      res.writeHead(200).end(JSON.stringify({ ok: true }));
    });
    await listen(this.server, this.config.port, this.config.host);
    this.setState("connected");
  }

  async disconnect(): Promise<void> {
    await closeServer(this.server);
    this.server = null;
    this.setState("disconnected");
  }

  getStatus(): ChannelStatus {
    return { state: this._state, changedAt: this.stateChangedAt, sentCount: this.sentCount, receivedCount: this.receivedCount };
  }

  async sendMessage(options: SendMessageOptions): Promise<ChannelMessage> {
    // Call platform API to send
    const msg = appendBotMessage(this.history, this.channelType, options, this.generateId);
    this.sentCount++;
    return msg;
  }

  onMessage(cb: MessageCallback): () => void {
    return subscribeMessage(this.callbacks, cb);
  }

  async getHistory(opts?: HistoryOptions): Promise<ChannelMessage[]> {
    return filterChannelHistory(this.history, opts);
  }

  private setState(s: ConnectionState): void {
    this._state = s;
    this.stateChangedAt = new Date().toISOString();
  }
}
```

### 3. Key Points

- Use the three helper functions `subscribeMessage()`, `appendBotMessage()`, and `filterChannelHistory()` (from `channel-helpers.ts`) to avoid reinventing the wheel.
- The `raw` field in `convertToChannelMessage()` should preserve platform-specific raw data for debugging.
- HTTP server-based channels should handle `url_verification` challenges (see Feishu implementation).
- WebSocket-based channels should handle heartbeat keep-alive (see Discord implementation).

### 4. Register and Use

```typescript
gateway.addAdapter("my-channel", new MyChannelAdapter({ apiKey: "xxx", port: 8080 }));
await gateway.connect("my-channel");
```

## Message Helper Functions

`channel-helpers.ts` provides three utility functions:

- **`subscribeMessage(callbacks, cb)`**: Register a callback, return unsubscribe function
- **`appendBotMessage(history, channelType, options, generateId)`**: Build a bot reply message and add to history
- **`filterChannelHistory(history, options)`**: Filter history by `after/before/senderId/limit`

## Gateway Integration

The `packages/gateway` package integrates the Channel system with the capability registry:

- **Capability registry (`capability-registry.ts`)**: Manages which channels are available and their capability scopes
- **Project registry (`project-registry.ts`)**: Manages channel settings from project configurations
- **Health checks (`doctor.ts`)**: Detects channel connection status and issues

## Configuration Examples

CLI channel:
```json
{ "channels": { "cli": { "type": "cli", "mode": "interactive", "prompt": "vera> " } } }
```

HTTP API channel:
```json
{ "channels": { "api": { "type": "api", "port": 8080, "apiKey": "..." } } }
```

Discord channel:
```json
{ "channels": { "discord": { "type": "discord", "botToken": "...", "applicationId": "..." } } }
```

Feishu channel:
```json
{ "channels": { "feishu": { "type": "feishu", "appId": "...", "appSecret": "...", "verificationToken": "...", "port": 8080 } } }
```

Multi-channel combination:
```json
{
  "channels": {
    "cli": { "type": "cli" },
    "api": { "type": "api", "port": 8080 },
    "feishu": { "type": "feishu", "appId": "...", "appSecret": "...", "verificationToken": "...", "port": 8081 },
    "discord": { "type": "discord", "botToken": "..." }
  }
}
```

---

**Related files**:
- `packages/core/src/channel/types.ts` -- Channel interfaces and message type definitions
- `packages/core/src/channel/gateway.ts` -- ChannelGateway implementation
- `packages/core/src/channel/cli-channel.ts` -- CLI channel adapter
- `packages/core/src/channel/api-channel.ts` -- HTTP API channel adapter
- `packages/core/src/channel/discord-channel.ts` -- Discord Bot adapter
- `packages/core/src/channel/feishu-channel.ts` -- Feishu Bot adapter
- `packages/core/src/channel/channel-helpers.ts` -- Shared helper functions
- `packages/core/src/channel/plugin-registry.ts` -- Channel plugin registry
- `packages/gateway/src/capability-registry.ts` -- Gateway capability registry
