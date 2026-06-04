# Channel 系统

> 本文档描述 OpenVera 的多平台消息互通 Channel 抽象层，包括统一的 `ChannelAdapter` 接口、Gateway 路由机制、已实现的 Channel，以及如何开发新的 Channel 适配器。

## 概述

Channel 系统提供统一的消息抽象，使 Agent 能够通过多个平台与用户交互：CLI、HTTP API、飞书（Lark）、Discord、企业微信、Slack、Telegram、WhatsApp 等。核心设计原则：

- **统一接口**：所有平台实现相同的 `ChannelAdapter` 接口
- **Gateway 路由**：`ChannelGateway` 管理多个 Channel 的生命周期，并统一将消息路由到处理器
- **Session 绑定**：支持将 Agent 会话绑定到特定 Channel，实现上下文关联
- **可扩展**：基于接口的插件设计；新增平台只需实现 `ChannelAdapter`

核心代码位于 `packages/core/src/channel/`。

## 架构

```
Agent Loop
     <->  消息处理器
ChannelGateway
  +-- CLI Adapter      （REPL/pipe）
  +-- API Adapter      （REST + WebSocket）
  +-- Discord Adapter  （Gateway WebSocket）
  +-- Feishu Adapter   （Webhook）
  +-- ...更多
       Session 绑定
```

- **ChannelAdapter**：单平台连接，发送/接收实现
- **ChannelGateway**：管理多个适配器、消息路由、Session 绑定、事件通知
- **SessionBinding**：将 Session ID 与 Channel 关联（`{ sessionId, channelName, boundAt, metadata }`）

## ChannelAdapter 接口

所有 Channel 适配器必须实现以下接口（定义在 `types.ts` 中）：

```typescript
interface ChannelAdapter {
  readonly name: string;                   // 唯一名称，如 "cli"、"feishu"
  readonly channelType: ChannelType;       // "cli" | "api" | "webhook" | "feishu" | "wecom" | "telegram" | "discord" | "slack" | "whatsapp" | "custom"
  readonly state: ConnectionState;         // "disconnected" | "connecting" | "connected" | "error"

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): ChannelStatus;              // { state, message?, changedAt, sentCount, receivedCount }

  sendMessage(options: SendMessageOptions): Promise<ChannelMessage>;
  onMessage(callback: MessageCallback): () => void;   // 返回取消订阅函数
  getHistory(options?: HistoryOptions): Promise<ChannelMessage[]>;
}
```

### 统一消息格式

所有 Channel 消息被标准化为 `ChannelMessage`：

```typescript
interface ChannelMessage {
  id: string;                          // 唯一消息 ID
  channelType: ChannelType;            // 来源平台
  senderId: string;                    // 发送者标识
  senderName?: string;                 // 发送者显示名称
  content: string;                     // 文本内容
  attachments: ChannelAttachment[];    // { type, url, name?, mimeType?, sizeBytes? }
  replyTo?: string;                    // 被回复的消息 ID
  timestamp: string;                   // ISO 时间戳
  raw?: unknown;                       // 平台特定原始数据
}
```

### 发送选项

```typescript
interface SendMessageOptions {
  content: string;
  attachments?: ChannelAttachment[];
  replyTo?: string;
  channelOptions?: Record<string, unknown>;  // 平台特定参数（如 Discord channelId、飞书 receiveId）
}
```

### 错误类型

```typescript
class ChannelError extends Error { code: string }               // 基类
class ChannelConnectionError extends ChannelError               // CHANNEL_CONNECTION
class ChannelSendError extends ChannelError                     // CHANNEL_SEND
class ChannelTimeoutError extends ChannelError                  // CHANNEL_TIMEOUT
class ChannelNotConnectedError extends ChannelError             // CHANNEL_NOT_CONNECTED
class ChannelNotFoundError extends ChannelError                 // CHANNEL_NOT_FOUND
```

## ChannelGateway

`ChannelGateway` 是 Channel 系统的中央调度器。默认配置：

| 参数 | 默认值 | 描述 |
|------|--------|------|
| `maxConnections` | 10 | 最大并发连接数 |
| `autoReconnect` | false | 是否自动重连 |
| `reconnectIntervalMs` | 5000 | 重连间隔 |
| `maxReconnectAttempts` | 3 | 最大重试次数 |

### 适配器管理

```typescript
const gateway = new ChannelGateway({ autoReconnect: true });

gateway.addAdapter("cli", new CliChannelAdapter());
gateway.addAdapter("discord", new DiscordChannelAdapter({ botToken: "..." }));

await gateway.connectAll();       // 并行连接所有 Channel，自动重试失败的
gateway.listAdapters();          // [{ name, state }]
gateway.removeAdapter("discord"); // 移除并清理订阅和 Session 绑定
await gateway.disconnectAll();
```

### 消息分发流程

```
外部消息到达 -> ChannelAdapter.onMessage 回调
  -> Gateway.dispatchMessage(msg, channelName)
    -> emitEvent("message_received")
    -> 遍历 messageHandlers，调用每个处理器
```

注册处理器：

```typescript
const unsub = gateway.onMessage(async (message, channelName) => {
  // message: ChannelMessage
  // channelName: string（如 "discord"、"feishu"）
  const response = await agent.handle(message.content);
  await gateway.sendMessage(channelName, {
    content: response,
    channelOptions: { /* 平台特定参数 */ },
  });
});
```

### Session 绑定

```typescript
gateway.bindSession("feishu", sessionId, { chatId: "xxx" });
gateway.getSession(sessionId);
gateway.getSessionsForChannel("feishu");
gateway.unbindSession(sessionId);
```

### 事件系统

```typescript
gateway.onEvent((event) => {
  // event.type:
  // "channel_connected" | "channel_disconnected" | "channel_error"
  // | "message_received" | "message_sent" | "reconnecting"
});
```

## 已实现的 Channel

### CLI Channel（CliChannelAdapter）

最基础的 Channel 实现。配置：

| 参数 | 默认值 | 描述 |
|------|--------|------|
| `mode` | `"interactive"` | `"interactive"`（REPL）/ `"pipe"`（stdin）/ `"non-interactive"` |
| `prompt` | `"> "` | REPL 提示符 |
| `input` | `process.stdin` | 自定义输入流 |
| `output` | `process.stdout` | 自定义输出流 |
| `senderId` | `"cli-user"` | 发送者 ID |

**interactive** 模式使用 `readline` 逐行读取；**pipe** 模式将整个 stdin 视为单条消息；**non-interactive** 模式通过 `processInput(input)` 接收输入。

### HTTP API Channel（ApiChannelAdapter）

REST API + WebSocket。配置：

| 参数 | 默认值 | 描述 |
|------|--------|------|
| `host` | `"0.0.0.0"` | 绑定地址 |
| `port` | 自动 | 监听端口 |
| `apiKey` | 无 | API 密钥认证 |
| `maxBodyBytes` | 1MB | 最大请求体大小 |

REST 端点：`GET /status`、`GET /messages`（支持 `limit/after/before/senderId` 参数）、`POST /messages`（body: `{ content, senderId? }`）。

WebSocket 实现了一个最小的 RFC 6455 服务器，通过 `?token=` 认证。消息格式：客户端发送 `{ type: "message", content }` 或 `{ type: "ping" }`；服务器回复 `{ type: "message", data }`、`{ type: "ack" }` 或 `{ type: "pong" }`。

### Discord Channel（DiscordChannelAdapter）

基于 Discord Gateway WebSocket（v10）+ REST API 的 Bot 实现。

核心机制：
- WebSocket Gateway 连接，带抖动防惊群心跳和僵尸连接检测
- 指数退避重连（1s、2s、4s、8s、... 最大 30s）
- 支持 Resume（断连后会话恢复）
- 自动过滤 Bot 自己的消息

发送消息需通过 `channelOptions.channelId` 指定目标 Channel：

```typescript
await gateway.sendMessage("discord", {
  content: "Hello!",
  channelOptions: {
    channelId: "123456789",
    embeds: [{ title: "Result", description: "..." }],
  },
});
```

### 飞书 / Lark Channel（FeishuChannelAdapter）

基于飞书开放平台 Webhook 的 Bot 实现。

核心机制：
- `tenant_access_token` 自动刷新（60 秒缓冲，并发去重）
- 支持 v2（`im.message.receive_v1`）和 v1 事件模式
- URL 验证（`url_verification` challenge）自动处理
- 支持 text / post / image / file 消息类型
- 发送消息需要 `channelOptions.receiveId` + `receiveIdType`

### 其他已实现的 Channel

| 文件 | Channel | 协议 |
|------|---------|------|
| `wecom-channel.ts` | 企业微信 | Webhook |
| `telegram-channel.ts` | Telegram | Bot API |
| `slack-channel.ts` | Slack | Bot API |
| `whatsapp-channel.ts` | WhatsApp | Business API |
| `webhook-channel.ts` | 通用 Webhook | 可配置签名验证 |

## Channel 生命周期

以飞书为例的完整流程：

1. **注册**：`gateway.addAdapter("feishu", adapter)`
2. **连接**：获取 `tenant_access_token` 验证凭据，启动 HTTP 服务器，发出 `"channel_connected"`
3. **接收消息**：飞书 POST webhook -> adapter 解析事件体 -> `ChannelMessage` -> `onMessage` 回调 -> `gateway.dispatchMessage()` -> 发出 `"message_received"` -> agent 处理器
4. **发送回复**：`gateway.sendMessage("feishu", {content, channelOptions})` -> 调用飞书开放 API -> 发出 `"message_sent"`
5. **断开**：关闭 HTTP 服务器，清理 token，发出 `"channel_disconnected"`

## 开发新的 Channel 适配器

以 webhook Channel 类型为模板，按以下四步操作：

### 1. 定义配置

```typescript
interface MyChannelConfig {
  apiKey: string;
  host?: string;
  port?: number;
  path?: string;          // 默认 "/my-channel/webhook"
}
```

### 2. 实现 ChannelAdapter

骨架代码：

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
    // 启动 HTTP 服务器
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
    // 调用平台 API 发送
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

### 3. 关键要点

- 使用三个辅助函数 `subscribeMessage()`、`appendBotMessage()` 和 `filterChannelHistory()`（来自 `channel-helpers.ts`）避免重复造轮子。
- `convertToChannelMessage()` 中的 `raw` 字段应保留平台特定原始数据，方便调试。
- 基于 HTTP 服务器的 Channel 应处理 `url_verification` 挑战（参见飞书实现）。
- 基于 WebSocket 的 Channel 应处理心跳保活（参见 Discord 实现）。

### 4. 注册并使用

```typescript
gateway.addAdapter("my-channel", new MyChannelAdapter({ apiKey: "xxx", port: 8080 }));
await gateway.connect("my-channel");
```

## 消息辅助函数

`channel-helpers.ts` 提供三个工具函数：

- **`subscribeMessage(callbacks, cb)`**：注册回调，返回取消订阅函数
- **`appendBotMessage(history, channelType, options, generateId)`**：构建 Bot 回复消息并添加到历史
- **`filterChannelHistory(history, options)`**：按 `after/before/senderId/limit` 过滤历史

## Gateway 集成

`packages/gateway` 包将 Channel 系统与能力注册中心集成：

- **能力注册中心（`capability-registry.ts`）**：管理哪些 Channel 可用及其能力范围
- **项目注册中心（`project-registry.ts`）**：管理来自项目配置的 Channel 设置
- **健康检查（`doctor.ts`）**：检测 Channel 连接状态和问题

## 配置示例

CLI Channel：
```json
{ "channels": { "cli": { "type": "cli", "mode": "interactive", "prompt": "vera> " } } }
```

HTTP API Channel：
```json
{ "channels": { "api": { "type": "api", "port": 8080, "apiKey": "..." } } }
```

Discord Channel：
```json
{ "channels": { "discord": { "type": "discord", "botToken": "...", "applicationId": "..." } } }
```

飞书 Channel：
```json
{ "channels": { "feishu": { "type": "feishu", "appId": "...", "appSecret": "...", "verificationToken": "...", "port": 8080 } } }
```

多 Channel 组合：
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

**相关文件**：
- `packages/core/src/channel/types.ts` -- Channel 接口和消息类型定义
- `packages/core/src/channel/gateway.ts` -- ChannelGateway 实现
- `packages/core/src/channel/cli-channel.ts` -- CLI Channel 适配器
- `packages/core/src/channel/api-channel.ts` -- HTTP API Channel 适配器
- `packages/core/src/channel/discord-channel.ts` -- Discord Bot 适配器
- `packages/core/src/channel/feishu-channel.ts` -- 飞书 Bot 适配器
- `packages/core/src/channel/channel-helpers.ts` -- 共享辅助函数
- `packages/core/src/channel/plugin-registry.ts` -- Channel 插件注册中心
- `packages/gateway/src/capability-registry.ts` -- Gateway 能力注册中心
