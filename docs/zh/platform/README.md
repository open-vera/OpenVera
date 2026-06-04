# Platform — 平台扩展能力文档

Platform 层负责 Vera 向更宽环境的扩展：Computer Use、MCP 接入、智能 UI 测试等。对应 roadmap P2/P3 阶段。

## 文档目录

| 文档 | 内容 |
|---|---|
| [computer-use.md](./computer-use.md) | Computer Use——浏览器自动化（Playwright/CDP）、桌面操作、Benchmark 接入 |
| [intelligent-testing.md](./intelligent-testing.md) | 智能自动化测试——AI 驱动 UI 测试、多策略元素定位、截图语义验证、自愈测试 |

## 待补充文档（P3）

- `mcp.md` — MCP client 接入与 tool 权限治理
- `multi-agent.md` — 跨 agent 消息总线与任务调度

## 主要包结构

```
apps/
  harness-ui/      Harness Web UI（Vue + Node server）
    web/           前端：runs 列表、流式日志、Artifact 浏览
    server/        后端：REST API，代理 harness 运行

packages/
  (Computer Use / MCP client 待建)
```
