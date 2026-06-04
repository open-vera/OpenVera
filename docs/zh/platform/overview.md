# Platform —— 平台扩展能力

Platform 层涵盖 Vera 向更广泛环境的扩展：Computer Use、MCP 集成、智能 UI 测试等。对应 roadmap 中 P2/P3 阶段。

## 文档索引

| 文档 | 内容 |
|------|------|
| [rag.md](./rag.md) | RAG 系统 —— 检索增强生成、嵌入向量、向量存储、增量索引 |
| [sandbox.md](./sandbox.md) | 沙箱隔离 —— Docker、CubeSandbox、安全代码执行 |
| [mcp.md](./mcp.md) | MCP 支持 —— Model Context Protocol 客户端、工具映射、服务发现 |
| [channel.md](./channel.md) | Channel 系统 —— 多平台消息互通（CLI、API、Discord、飞书等） |
| [storage.md](./storage.md) | 存储架构 —— SQLite、键值抽象、会话/记忆持久化 |
| [computer-use.md](./computer-use.md) | Computer Use —— 浏览器自动化（Playwright/CDP）、桌面操作、基准测试 |
| [intelligent-testing.md](./intelligent-testing.md) | 智能自动化测试 —— AI 驱动 UI 测试、多策略元素定位、截图语义验证、自愈测试 |

## 待补充文档（P3）

- `multi-agent.md` —— 跨 Agent 消息总线与任务调度

## 主要包结构

```
apps/
  harness-ui/      Harness Web UI（Vue + Node server）
    web/           前端：运行列表、流式日志、产物浏览器
    server/        后端：REST API，代理 harness 运行

packages/
  （Computer Use / MCP 客户端 —— 待创建）
```
