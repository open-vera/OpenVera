# Computer Use — 浏览器与客户端操作

## 定位

让 agent 能直接操作 UI：打开网页、填表单、点按钮、截图确认，以及操作桌面原生应用。这是 agent 从"语言任务"走向"实际执行"的关键能力。

作为 `@vera/core` 里的标准 tool 暴露给 loop，agent 通过调用工具来驱动 UI，不需要感知底层是 Playwright 还是截图+视觉模型。

---

## 架构

```
packages/
  core/
    src/
      tools/
        browser.ts      # BrowserTool — Playwright 驱动
        desktop.ts      # DesktopTool — 截图 + 鼠标键盘
        screen.ts       # ScreenTool — 视觉理解辅助（坐标定位）
```

agent loop 里 tool call 流转：

```
agent → tool_call: browser_navigate(url)
      → BrowserTool.execute()
      → Playwright: page.goto(url)
      → 返回 screenshot + page_title + url
agent → tool_call: browser_click(selector / description)
      → BrowserTool.execute()
      → 视觉定位 or CSS selector
      → 返回 screenshot（点击后状态）
```

---

## 浏览器工具（BrowserTool）

### 技术方案

**Playwright**（首选）：
- 支持 Chromium / Firefox / WebKit
- CDP 协议，可接管已有浏览器实例
- 截图、PDF、网络拦截完备

**CDP 直连**（补充）：
- 接管用户已打开的 Chrome，无需新开实例
- 适合"在用户当前页面上操作"的场景

### Tool 定义

```ts
// agent 可调用的浏览器动作
type BrowserAction =
  | { type: "navigate";    url: string }
  | { type: "click";       selector?: string; description?: string }
  | { type: "type";        selector: string; text: string }
  | { type: "scroll";      direction: "up" | "down"; amount?: number }
  | { type: "screenshot" }
  | { type: "extract";     query: string }   // 从当前页提取信息
  | { type: "wait";        condition: string; timeout_ms?: number }
```

### 截图回传策略

每次动作后截图，以 base64 图片形式放入 tool_result，让模型看到当前页面状态再决定下一步。

截图尺寸建议 1280×800，过大会消耗过多 token：

```ts
// tool_result content
{
  "type": "image_url",
  "image_url": { "url": "data:image/png;base64,..." }
}
```

### 视觉定位（当 CSS selector 不可用时）

发给视觉模型：

```
当前截图（附上），请找到"{description}"元素的坐标（x, y），
返回 JSON：{"x": 123, "y": 456, "confidence": 0.9}
```

用 `page.mouse.click(x, y)` 执行。

---

## 桌面客户端工具（DesktopTool）

### 技术方案

| 场景 | 方案 |
|---|---|
| macOS 原生应用 | `screencapture` 截图 + `cliclick` 鼠标键盘 |
| 跨平台 | `robotjs` / `nut-js`（Node.js） |
| 视觉理解 | 截图 → 多模态模型定位元素 → 执行动作 |

### Tool 定义

```ts
type DesktopAction =
  | { type: "screenshot" }
  | { type: "click";       x: number; y: number }
  | { type: "double_click"; x: number; y: number }
  | { type: "type";        text: string }
  | { type: "key";         keys: string }     // e.g. "cmd+c"
  | { type: "find_element"; description: string }  // 返回坐标
  | { type: "scroll";      x: number; y: number; delta: number }
```

### 动作循环

```
截图 → 模型分析当前状态 → 决定下一个动作 → 执行 → 截图确认 → ...
```

每步截图是必要的 overhead，确保模型看到真实状态，避免盲操作。

---

## 安全边界

电脑操作能力强，需要明确限制：

| 限制项 | 策略 |
|---|---|
| 允许访问的域名 | `.vera/settings.json` 配白名单 |
| 禁止的操作 | 删除文件、提交支付、发送邮件需二次确认 |
| 沙箱模式 | 开发/测试时用独立浏览器 profile，隔离 cookie |
| 操作审计 | 每个动作写入 trace log，可回放 |

---

## Benchmark

专项评测集：

| 评测集 | 场景 | 说明 |
|---|---|---|
| **WebArena** | 真实网站多步 web 任务 | 购物、论坛、代码仓库等 5 类网站 |
| **OSWorld** | 跨应用桌面操作 | 截图 + 动作序列，369 个真实任务 |
| **ScreenSpot** | GUI grounding | 给描述，点到正确元素，测视觉定位精度 |
| **Mind2Web** | 网页任务泛化 | 测在没见过网站上的迁移能力 |

**Vera 的建议策略**：
1. 先跑 **ScreenSpot**：纯视觉定位，不依赖完整 agent loop，可以快速验证视觉模型选型
2. 再跑 **WebArena** 子集（shopping 场景）：有明确成功标准
3. **OSWorld** 作为长期目标，难度最高

---

## 实现路线

```
阶段 1 — 浏览器基础
  Playwright 封装 → navigate / screenshot / click(selector)
  接入 core tool registry → agent 可调用

阶段 2 — 视觉定位
  click(description) → 截图 → 多模态模型定位坐标
  ScreenSpot 上验证定位精度

阶段 3 — 桌面支持
  macOS 截图 + nut-js 动作
  接入 DesktopTool

阶段 4 — 安全与审计
  域名白名单 / 敏感操作确认 / trace log
```
