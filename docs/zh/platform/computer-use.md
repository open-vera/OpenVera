# Computer Use —— 桌面与浏览器自动化

## 概述

使 Agent 能够直接操作用户界面：打开网页、填写表单、点击按钮、截图验证，以及控制原生桌面应用。这是将 Agent 从"语言任务"推向"实际执行"的核心能力。

Computer Use 以**统一元工具**（`computer_use`）的形式暴露给 Agent 循环：Agent 只需描述任务目标，元工具自动检测执行环境并路由到合适的子工具。同时支持**组合任务拆解**和**多步编排**，可通过单次调用完成"打开网站、登录、下载文件并解析"等复杂工作流。

---

## 架构一览

```
┌─────────────────────────────────────────────────┐
│            computer_use（元工具）                 │
│  环境检测 → 任务拆解                             │
│  → 单次派发 / 多步编排                           │
├─────────────────────────────────────────────────┤
│  子工具（6 个）                                  │
│  ├─ browser           Playwright 浏览器控制       │
│  ├─ desktop_input     鼠标/键盘模拟              │
│  ├─ desktop_script    脚本执行                   │
│  ├─ desktop_screenshot  桌面截图                 │
│  ├─ desktop_accessibility  无障碍树              │
│  └─ bash              Shell 命令执行             │
├─────────────────────────────────────────────────┤
│  MultiStepOrchestrator（编排引擎）                │
│  顺序执行 · 变量传递                             │
│  · 条件分支 · 出错重试/跳过                      │
└─────────────────────────────────────────────────┘
```

元工具执行流程：

```
agent → tool_call: computer_use({ task: "打开 example.com 并截图" })
      → 检测环境（browser / desktop / cli）
      → 尝试多步编排（login / downloadAndParse 模式）
      → 尝试简单任务拆解（navigate+screenshot 组合）
      → 单次派发（路由到具体子工具）
      → 返回结果
```

---

## 自动环境检测

`computer_use` 根据任务描述中的关键词自动判断目标环境：

| 环境 | 触发关键词 |
|------|-----------|
| `browser` | website, url, http, navigate, browse, web page, click link, fill form, login, browser, chromium, chrome, playwright |
| `desktop` | desktop, mouse, keyboard, click at, type text, hotkey, shortcut, finder, spotlight, drag, scroll, double click, right click |
| `cli` | run command, shell, execute, terminal, install, npm, pnpm, git, curl, docker, apt, brew, pip |

检测逻辑：按环境统计关键词匹配得分，得分最高者胜出。平局时，如果任务中包含 URL 则优先 `browser`，否则优先 `cli`。

也可显式指定 `environment` 参数：`"browser" | "desktop" | "cli" | "auto"`（默认 `"auto"`）。

---

## computer_use 元工具

### 参数

| 参数 | 类型 | 必填 | 描述 |
|------|------|------|------|
| `task` | string | 是 | 高层任务描述，如 `"打开 example.com 并截图"` |
| `environment` | string | 否 | 目标环境：`auto`（默认）/ `browser` / `desktop` / `cli` |
| `action` | string | 否 | 显式子操作覆盖，如 `navigate`、`click`、`screenshot` |
| `url` | string | 否 | 浏览器导航目标 URL |
| `selector` | string | 否 | CSS 选择器 |
| `text` | string | 否 | 要输入的文本（浏览器或桌面） |
| `expression` | string | 否 | 浏览器 evaluate 的 JavaScript 表达式 |
| `inputAction` | string | 否 | 桌面输入操作：`click` / `doubleClick` / `rightClick` / `move` / `type` / `key` / `hotkey` / `scroll` |
| `x` / `y` | number | 否 | 桌面鼠标坐标 |
| `key` | string | 否 | 桌面按键名称 |
| `modifiers` | string[] | 否 | 修饰键，如 `["ctrl", "shift"]` |
| `script` | string | 否 | 桌面脚本内容 |
| `scriptType` | string | 否 | 脚本类型：`applescript` / `shell` / `javascript` |
| `command` | string | 否 | CLI 环境的 shell 命令 |
| `screenshotPath` | string | 否 | 截图输出路径 |
| `timeout` | number | 否 | 超时覆盖（毫秒），默认 120000 |

### 风险等级：`medium`

### 任务拆解

元工具支持三种执行路径：

1. **多步编排**（优先）：匹配复杂模式（登录流程、下载并解析），使用 `MultiStepOrchestrator`
2. **简单组合拆解**：匹配 `decomposeTask` 中预定义的组合模式（navigate+screenshot、navigate+click、navigate+type），顺序执行子步骤
3. **单次派发**：将任务路由到最佳匹配的子工具

---

## browser —— 浏览器自动化

基于 Playwright 的 Chromium 驱动，支持 18 种操作。

### 技术方案

- **Playwright**（默认）：启动无头 Chromium；调试时可开启有头模式
- **CDP 直连**：通过 `connect` 操作附加到已有 Chrome 实例（通过 `cdpUrl` 参数，如 `http://localhost:9222`），在用户当前浏览器上操作
- **会话管理**：每个会话维护独立的浏览器上下文，支持 cookie 持久化和多标签管理

### 操作

| 操作 | 描述 | 必需参数 |
|------|------|---------|
| `navigate` | 导航到 URL | `url` |
| `click` | 点击元素 | `selector` |
| `type` | 向元素输入文本 | `selector`、`text` |
| `screenshot` | 截取页面截图 | 无（可选 `path`、`fullPage`） |
| `evaluate` | 在页面中执行 JS | `expression` |
| `waitForSelector` | 等待元素出现 | `selector` |
| `close` | 关闭浏览器会话 | 无 |
| `connect` | 通过 CDP 连接已有 Chrome | `cdpUrl` |
| `disconnect` | 断开 CDP 会话 | 无 |
| `newTab` | 打开新标签 | 无（可选 `url`） |
| `switchTab` | 切换到指定标签 | `tabIndex` |
| `closeTab` | 关闭指定标签 | `tabIndex` |
| `listTabs` | 列出所有标签信息 | 无 |
| `saveCookies` | 保存 cookie 到文件 | `sessionPath` |
| `loadCookies` | 从文件加载 cookie | `sessionPath` |
| `saveSession` | 保存完整会话（cookie + 标签） | `sessionPath` |
| `loadSession` | 恢复完整会话 | `sessionPath` |

### 配置参数

| 参数 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `timeout` | number | 30000 | 操作超时（毫秒） |
| `headed` | boolean | false | 有头模式（调试用） |
| `width` | number | 1280 | 视口宽度 |
| `height` | number | 720 | 视口高度 |
| `fullPage` | boolean | false | 全页截图 |
| `waitUntil` | string | `"load"` | 导航完成条件：`load` / `domcontentloaded` / `networkidle` |

### 风险等级：`medium`

### 使用示例

```json
// 导航并截图
{ "action": "navigate", "url": "https://example.com" }
{ "action": "screenshot", "path": "/tmp/page.png", "fullPage": true }

// CDP 连接已有 Chrome（先启动：chrome --remote-debugging-port=9222）
{ "action": "connect", "cdpUrl": "http://localhost:9222" }

// 保存和恢复会话
{ "action": "saveSession", "sessionPath": "/tmp/session.json" }
{ "action": "loadSession", "sessionPath": "/tmp/session.json" }
```

---

## desktop_input —— 鼠标与键盘模拟

跨平台输入模拟工具，在系统层面控制鼠标和键盘。

### 平台支持

| 平台 | 方案 | 安装命令 |
|------|------|---------|
| macOS | cliclick + osascript | `brew install cliclick` |
| Linux | xdotool | `sudo apt install xdotool` |

### 操作

| 操作 | 描述 | 必需参数 |
|------|------|---------|
| `click` | 鼠标左键点击 | `x`、`y` |
| `doubleClick` | 鼠标左键双击 | `x`、`y` |
| `rightClick` | 鼠标右键点击 | `x`、`y` |
| `move` | 移动鼠标 | `x`、`y` |
| `type` | 输入文本 | `text` |
| `key` | 按下单个按键 | `key` |
| `hotkey` | 组合键 | `key`、`modifiers` |
| `scroll` | 滚轮滚动 | `scrollX` 或 `scrollY` |

### 参数

| 参数 | 类型 | 必填 | 描述 |
|------|------|------|------|
| `action` | string | 是 | 输入操作 |
| `x` / `y` | number | 按操作 | 坐标 |
| `text` | string | 按操作 | 要输入的文本 |
| `key` | string | 按操作 | 按键名称，支持 `return`、`tab`、`escape`、`backspace`、`space`、方向键等 |
| `modifiers` | string[] | 按操作 | 修饰键：`ctrl`/`control`、`cmd`/`command`、`alt`/`option`、`shift` |
| `scrollX` / `scrollY` | number | 按操作 | 滚动量（正值 = 向下/向右） |
| `typeDelay` | number | 否 | 按键间隔（毫秒） |

### 风险等级：`medium`

---

## desktop_script —— 脚本执行

在桌面环境中执行脚本，用于系统应用控制。

### 脚本类型

| 类型 | 平台 | 用例 | 底层机制 |
|------|------|------|---------|
| `applescript` | 仅 macOS | 控制 Finder、Safari 等系统应用 | `osascript -e` |
| `shell` | 跨平台 | 通用 shell 命令 | `child_process.exec` |
| `javascript` | 仅 macOS | 通过 osascript JS 访问 UI 元素 | `osascript -l JavaScript -e` |

### 参数

| 参数 | 类型 | 必填 | 描述 |
|------|------|------|------|
| `type` | string | 是 | 脚本类型 |
| `script` | string | 是 | 脚本内容 |
| `timeout` | number | 否 | 超时（毫秒），默认 30000 |
| `cwd` | string | 否 | 工作目录（仅 shell） |
| `env` | object | 否 | 环境变量（仅 shell） |

### 风险等级：`high`

### 使用示例

```json
// macOS：激活 Safari
{ "type": "applescript", "script": "tell application \"Safari\" to activate" }

// 跨平台：列出进程
{ "type": "shell", "script": "ps aux | head -20" }

// macOS：通过 JavaScript 访问 UI 元素
{ "type": "javascript", "script": "Application('System Events').processes[0].name()" }
```

---

## desktop_screenshot —— 桌面截图

截取桌面屏幕。支持全屏、窗口和区域三种模式。

### 平台支持

| 平台 | 方案 |
|------|------|
| macOS | `screencapture`（原生） |
| Linux | scrot → import（ImageMagick）→ gnome-screenshot（自动回退） |

### 参数

| 参数 | 类型 | 必填 | 描述 |
|------|------|------|------|
| `mode` | string | 否 | 截图模式：`fullscreen`（默认）/ `window` / `region` |
| `path` | string | 否 | 输出路径（默认在 cwd 中自动生成） |
| `delay` | number | 否 | 延迟秒数 |
| `format` | string | 否 | 图片格式：`png`（默认）/ `jpg` |
| `windowTitle` | string | 否 | 窗口标题（仅 macOS，窗口模式） |
| `display` | number | 否 | 显示器索引（仅 macOS，多显示器） |

### 风险等级：`low`

---

## desktop_accessibility —— 无障碍树检查

通过系统无障碍 API 检查 UI 元素结构和属性，使 Agent 无需依赖视觉模型即可"看见"屏幕上的元素。

### 平台支持

| 平台 | 方案 |
|------|------|
| macOS | osascript -l JavaScript（AXUIElement，完整支持） |
| Linux | wmctrl / xdotool（有限，无元素树） |

### 操作

| 操作 | 描述 | 必需参数 |
|------|------|---------|
| `listApps` | 列出所有可见应用（含 bundleId、PID） | 无 |
| `listWindows` | 列出指定应用的所有窗口（位置、大小） | `appName` |
| `getFocusedElement` | 获取当前聚焦窗口信息 | 无 |
| `dumpTree` | 导出 UI 元素层级树（role、title、value、enabled、position、size） | `appName` |

### 参数

| 参数 | 类型 | 必填 | 描述 |
|------|------|------|------|
| `action` | string | 是 | 操作 |
| `appName` | string | 按操作 | 应用名称 |
| `maxDepth` | number | 否 | dumpTree 的最大树深度，默认 3 |

### 风险等级：`low`

### 返回的 UIElement 结构

```ts
interface UIElement {
  role?: string;        // AXRole：button、textField、window...
  title?: string;       // 元素标题
  value?: string;       // 当前值
  description?: string; // 无障碍描述
  enabled?: boolean;    // 元素是否可用
  position?: { x: number; y: number };
  size?: { width: number; height: number };
  children?: UIElement[]; // 子元素（深度由 maxDepth 控制，最多 20）
}
```

---

## MultiStepOrchestrator —— 多步编排引擎

编排引擎将多个工具调用组合成有序的执行序列，支持变量传递、条件分支和错误恢复。

### 核心功能

| 功能 | 描述 |
|------|------|
| **顺序执行** | 步骤按定义顺序执行；前一步的输出可作为下一步的输入 |
| **变量传递** | `${stepId.output}` 引用前一步的输出内容 |
| **条件分支** | 步骤是否执行由前一步结果决定 |
| **错误恢复** | 三种策略：`abort`（终止）、`skip`（跳过继续）、`retry`（重试） |
| **超时控制** | 全局超时（默认 5 分钟）+ 每步独立超时 |

### StepDefinition 结构

```ts
interface StepDefinition {
  id: string;            // 唯一步骤标识
  tool: string;          // 工具名称（browser、bash、visual_analyze 等）
  args: Record<string, unknown>; // 工具参数，支持 ${var} 插值
  description?: string;  // 人类可读的描述
  onError?: "abort" | "skip" | "retry"; // 默认 "abort"
  maxRetries?: number;   // 最大重试次数，默认 0
  condition?: StepCondition; // 执行条件
  timeoutMs?: number;    // 每步超时
}
```

### 条件操作符

| 操作符 | 描述 |
|--------|------|
| `success` | 前一步执行成功 |
| `failure` | 前一步失败 |
| `contains` | 前一步输出包含指定字符串 |
| `equals` | 前一步输出等于指定字符串 |
| `matches` | 前一步输出匹配正则表达式 |

### 预定义模式（StepPatterns）

编排引擎内置三种组合模式，可直接使用：

| 模式 | 步骤序列 | 用例 |
|------|---------|------|
| `browseAndAnalyze(url)` | navigate → screenshot → visual_analyze | 打开网页、截图并用 LLM vision 分析 |
| `login(url, credentials)` | navigate → fill_username → fill_password → submit | 自动化登录流程 |
| `downloadAndParse(url, selector, cmd)` | navigate → click_download → wait → parse | 下载文件并用命令解析 |

---

## 安全模型

Computer Use 能力强大且直接操作真实系统，需要严格的安全边界：

| 限制 | 策略 |
|------|------|
| 风险分级 | 每个子工具有风险标签：`low`（screenshot/accessibility）、`medium`（browser/input）、`high`（script） |
| 脚本执行 | `desktop_script` 标记为 `high` 风险，需要用户确认 |
| CDP 连接 | 仅允许 localhost CDP 端点 |
| 浏览器隔离 | 每个会话使用独立的 Playwright 上下文，隔离 cookie 和存储 |
| 操作审计 | 每次工具调用记录完整的参数和结果 |

---

## Sandbox 集成

Computer Use 工具通过 `ToolContext` 与沙箱系统集成：

- **sandboxProvider**：当 `ToolContext` 中注入沙箱提供者时，脚本执行可被限制在沙箱内
- **allowedPaths**：截图和脚本的文件路径受 `allowedPaths` 允许列表约束
- **dryRun**：支持演习模式；工具返回模拟结果

---

## 当前状态

| 组件 | 状态 | 说明 |
|------|------|------|
| `computer_use` 元工具 | 已完成 | 环境检测、任务拆解、单次/多步派发 |
| `browser` | 已完成 | Playwright + CDP 双模式，18 种操作 |
| `desktop_input` | 已完成 | macOS（cliclick/osascript）+ Linux（xdotool） |
| `desktop_script` | 已完成 | AppleScript + Shell + JavaScript（osascript） |
| `desktop_screenshot` | 已完成 | macOS（screencapture）+ Linux（scrot/import） |
| `desktop_accessibility` | 已完成 | macOS 完整支持，Linux 有限支持 |
| `MultiStepOrchestrator` | 已完成 | 变量传递、条件分支、错误恢复、预定义模式 |
| 视觉定位（visual_analyze） | 已完成 | 通过 `createVisualAnalyzeTool` 动态创建，依赖 LLM adapter |
| Windows 支持 | 未实现 | 目前仅支持 macOS 和 Linux |
