# Channel 系统

> 本文档描述 OpenVera 的多平台消息通道抽象层，包括统一的 `ChannelAdapter` 接口、Gateway 路由机制、已实现的通道以及新增通道适配器的开发方法。

## 概述

Channel 系统提供统一的消息收发抽象，让 agent 可以通过 CLI、HTTP API、飞书、Discord、微信企业号、Slack、Telegram、WhatsApp 等多种平台与用户交互。核心设计原则：

- **统一接口**：所有平台实现同一个 `ChannelAdapter` 接口
- **Gateway 路由**：`ChannelGateway` 管理多个 channel 的生命周期，将消息统一分发到 handler
- **会话绑定**：支持将 agent session 绑定到特定 channel，实现上下文关联
- **可扩展**：基于接口的插件化设计，新增平台只需实现 `ChannelAdapter`

核心代码位于 `packages/core/src/channel/`。

## 架构

```
Agent Loop
     ↕  Message Handlers
ChannelGateway
  ├── CLI Adapter      (REPL/pipe)
  ├── API Adapter      (REST + WebSocket)
  ├── Discord Adapter  (Gateway WebSocket)
  ├── Feishu Adapter   (Webhook)
  └── ...更多
       Session Bindings
```

- **ChannelAdapter**：单个平台的连接、收发实现
- **ChannelGateway**：管理多个 adapter、消息路由、会话绑定、事件通知
- **SessionBinding**：将 session ID 与 channel 关联（`{ sessionId, channelName, boundAt, metadata }`）

## ChannelAdapter 接口

所有通道适配器必须实现以下接口（定义于 `types.ts`）：

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

所有通道的消息统一为 `ChannelMessage`：

```typescript
interface ChannelMessage {
  id: string;                          // 消息唯一 ID
  channelType: ChannelType;            // 来源平台
  senderId: string;                    // 发送者标识
  senderName?: string;                 // 发送者显示名
  content: string;                     // 文本内容
  attachments: ChannelAttachment[];    // { type, url, name?, mimeType?, sizeBytes? }
  replyTo?: string;                    // 被回复的消息 ID
  timestamp: string;                   // ISO 时间戳
  raw?: unknown;                       // 平台特定的原始数据
}
```

### 发送选项

```typescript
interface SendMessageOptions {
  content: string;
  attachments?: ChannelAttachment[];
  replyTo?: string;
  channelOptions?: Record<string, unknown>;  // 平台特定参数（如 Discord 的 channelId、Feishu 的 receiveId）
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

`ChannelGateway` 是通道系统的中心调度器。默认配置：

| 参数 | 默认值 | 说明 |
|---|---|---|
| `maxConnections` | 10 | 最大并发连接数 |
| `autoReconnect` | false | 是否自动重连 |
| `reconnectIntervalMs` | 5000 | 重连间隔 |
| `maxReconnectAttempts` | 3 | 最大重试次数 |

### Adapter 管理

```typescript
const gateway = new ChannelGateway({ autoReconnect: true });

gateway.addAdapter("cli", new CliChannelAdapter());
gateway.addAdapter("discord", new DiscordChannelAdapter({ botToken: "..." }));

await gateway.connectAll();       // 并行连接所有通道，自动重连失败项
gateway.listAdapters();          // [{ name, state }]
gateway.removeAdapter("discord"); // 移除并清理订阅和会话绑定
await gateway.disconnectAll();
```

### 消息分发流程

```
外部消息到达 → ChannelAdapter.onMessage cb
  → Gateway.dispatchMessage(msg, channelName)
    → emitEvent("message_received")
    → 遍历 messageHandlers 逐一调用
```

注册 handler：

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

### 会话绑定

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

## 已实现的通道

### CLI 通道（CliChannelAdapter）

最基础的通道实现。配置项：

| 参数 | 默认值 | 说明 |
|---|---|---|
| `mode` | `"interactive"` | `"interactive"`（REPL）/ `"pipe"`（stdin）/ `"non-interactive"` |
| `prompt` | `"> "` | REPL 提示符 |
| `input` | `process.stdin` | 自定义输入流 |
| `output` | `process.stdout` | 自定义输出流 |
| `senderId` | `"cli-user"` | 发送者 ID |

**interactive** 模式使用 `readline` 逐行读取；**pipe** 模式将全部 stdin 作为一条消息；**non-interactive** 模式通过 `processInput(input)` 手动注入。

### HTTP API 通道（ApiChannelAdapter）

REST API + WebSocket。配置项：

| 参数 | 默认值 | 说明 |
|---|---|---|
| `host` | `"0.0.0.0"` | 绑定地址 |
| `port` | 自动 | 监听端口 |
| `apiKey` | 无 | API 密钥认证 |
| `maxBodyBytes` | 1MB | 请求体最大字节数 |

REST 端点：`GET /status`、`GET /messages`（支持 `limit/after/before/senderId` 参数）、`POST /messages`（body: `{ content, senderId? }`）。

WebSocket 支持 RFC 6455 最小实现，通过 `?token=` 认证。消息格式：客户端发送 `{ type: "message", content }` 或 `{ type: "ping" }`；服务端回复 `{ type: "message", data }`、`{ type: "ack" }` 或 `{ type: "pong" }`。

### Discord 通道（DiscordChannelAdapter）

基于 Discord Gateway WebSocket (v10) + REST API 的 Bot 实现。

核心机制：
- WebSocket Gateway 连接，含 jitter 防惊群 heartbeat、zombie connection 检测
- 指数退避重连（1s, 2s, 4s, 8s, ... 最多 30s）
- 支持 Resume（断线恢复 session）
- 自动过滤 bot 自己发出的消息

发送消息需通过 `channelOptions.channelId` 指定目标频道：

```typescript
await gateway.sendMessage("discord", {
  content: "你好！",
  channelOptions: {
    channelId: "123456789",
    embeds: [{ title: "结果", description: "..." }],
  },
});
```

### 飞书 / Lark 通道（FeishuChannelAdapter）

基于飞书开放平台 Webhook 的 Bot 实现。

核心机制：
- `tenant_access_token` 自动刷新（60s 缓冲，并发去重）
- 支持 v2 (`im.message.receive_v1`) 和 v1 事件 schema
- URL 验证 (`url_verification` challenge) 自动处理
- 支持 text / post / image / file 四种消息类型
- 发送消息需通过 `channelOptions.receiveId` + `receiveIdType`

### 其他已实现通道

| 文件 | 通道 | 协议 |
|---|---|---|
| `wecom-channel.ts` | 企业微信（WeCom） | Webhook |
| `telegram-channel.ts` | Telegram | Bot API |
| `slack-channel.ts` | Slack | Bot API |
| `whatsapp-channel.ts` | WhatsApp | Business API |
| `webhook-channel.ts` | 通用 Webhook | 可配置签名验证 |

## 通道生命周期

以飞书为例的完整流程：

1. **注册**：`gateway.addAdapter("feishu", adapter)`
2. **连接**：获取 `tenant_access_token` 验证凭证，启动 HTTP server，发射 `"channel_connected"`
3. **接收消息**：飞书 POST webhook -> adapter 解析事件体 -> `ChannelMessage` -> `onMessage` callbacks -> `gateway.dispatchMessage()` -> 发射 `"message_received"` -> agent handler
4. **发送响应**：`gateway.sendMessage("feishu", {content, channelOptions})` -> 调用飞书 Open API -> 发射 `"message_sent"`
5. **断开**：关闭 HTTP server，清理 token，发射 `"channel_disconnected"`

## 实现新的通道适配器

以 Webhook 类型通道为模板，四个步骤：

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
    // 启动 HTTP server
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

### 3. 关键点

- 使用 `subscribeMessage()` / `appendBotMessage()` / `filterChannelHistory()` 三个 helper 函数（来自 `channel-helpers.ts`）避免重复造轮子
- `convertToChannelMessage()` 中的 `raw` 字段保留平台原始数据，方便调试
- HTTP server 类的通道注意处理 `url_verification` challenge（参考 Feishu 实现）
- WebSocket 类的通道注意 heartbeat 保持连接（参考 Discord 实现）

### 4. 注册使用

```typescript
gateway.addAdapter("my-channel", new MyChannelAdapter({ apiKey: "xxx", port: 8080 }));
await gateway.connect("my-channel");
```

## 消息助手函数

`channel-helpers.ts` 提供三个通用函数：

- **`subscribeMessage(callbacks, cb)`**：注册回调，返回取消订阅函数
- **`appendBotMessage(history, channelType, options, generateId)`**：构建 bot 回复消息并加入 history
- **`filterChannelHistory(history, options)`**：按 `after/before/senderId/limit` 过滤历史

## Gateway 集成

`packages/gateway` 包将 Channel 系统与能力注册中心整合：

- **能力注册（`capability-registry.ts`）**：管理哪些 channel 可用、各自的能力范围
- **项目注册（`project-registry.ts`）**：管理项目配置中的 channel 设置
- **健康检查（`doctor.ts`）**：检测 channel 连接状态和问题

## 配置示例

CLI 通道：
```json
{ "channels": { "cli": { "type": "cli", "mode": "interactive", "prompt": "vera> " } } }
```

HTTP API 通道：
```json
{ "channels": { "api": { "type": "api", "port": 8080, "apiKey": "..." } } }
```

Discord 通道：
```json
{ "channels": { "discord": { "type": "discord", "botToken": "...", "applicationId": "..." } } }
```

飞书通道：
```json
{ "channels": { "feishu": { "type": "feishu", "appId": "...", "appSecret": "...", "verificationToken": "...", "port": 8080 } } }
```

多通道组合：
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
- `packages/core/src/channel/types.ts` — 通道接口与消息类型定义
- `packages/core/src/channel/gateway.ts` — ChannelGateway 实现
- `packages/core/src/channel/cli-channel.ts` — CLI 通道适配器
- `packages/core/src/channel/api-channel.ts` — HTTP API 通道适配器
- `packages/core/src/channel/discord-channel.ts` — Discord Bot 适配器
- `packages/core/src/channel/feishu-channel.ts` — 飞书 Bot 适配器
- `packages/core/src/channel/channel-helpers.ts` — 共享辅助函数
- `packages/core/src/channel/plugin-registry.ts` — 通道插件注册表
- `packages/gateway/src/capability-registry.ts` — Gateway 能力注册中心
