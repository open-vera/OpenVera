# Intelligent Testing — 智能自动化测试方案

## 定位

用 AI agent 驱动 UI 测试：自动识别页面元素、执行交互、截图比对、生成验证结论。目标是让"写测试"这件事从手写脚本变成自然语言描述，agent 负责理解 UI、定位元素、执行断言。

```
测试描述（自然语言）
      ↓
  [Testing Agent]    ← 理解意图，拆解步骤
      ↓
  [Element Locator]  ← 多策略定位元素
      ↓
  [Browser / Desktop Action]
      ↓
  [Screenshot Verifier]  ← 截图 + 视觉模型断言
      ↓
  测试报告
```

---

## 元素定位策略

多策略按优先级依次尝试，任一成功即停止，失败自动降级：

```
1. accessibility_id   无障碍 ID，最稳定，不受样式/结构变化影响
2. xpath              精确路径，适合结构稳定的页面
3. css_selector       简洁，开发者工具直接复制
4. text               按可见文本匹配，适合按钮/链接/标签
5. visual             以上全失败时的 fallback：截图 → 多模态模型定位坐标
```

### 定位器配置

TestCase 可声明偏好策略，也可只写意图让 agent 自动选择：

```json
{
  "id": "login_submit",
  "step": "点击登录按钮",
  "locator": {
    "strategy": "text",
    "value": "登录",
    "fallback": "visual"
  }
}
```

不配置 `locator` 时，agent 按默认优先级逐一尝试。

### 视觉定位（Visual Fallback）

```
截图（当前页面）→ 多模态模型：
  "请找到'{description}'元素的坐标，返回 JSON：{"x": 123, "y": 456, "confidence": 0.9}"
→ page.mouse.click(x, y)
```

置信度 < 0.7 时不执行点击，记录为定位失败并截图存档。

---

## 自愈测试（Self-Healing）

传统 XPath 脚本在 DOM 变化后立即失效。智能测试的核心优势是**自愈**：

```
定位失败
  ↓
[Self-Healer]
  1. 用 accessibility_id 重试
  2. 用 text 匹配重试
  3. 截图 → 视觉模型重新定位
  4. 成功后更新 TestCase 中的 locator 策略（建议人工确认）
  5. 全部失败 → 记录为破坏性变更，生成 diff 报告
```

自愈日志写入报告，标注"哪个步骤发生了策略切换"，便于判断是正常重构还是 UI 回归。

---

## 截图验证

每步操作后截图，用于两类断言：

### 1. 结构断言（DOM/文本）

优先，准确且快：

```ts
// 断言页面包含某文本
expect(await page.locator("h1").textContent()).toBe("欢迎回来");

// 断言元素可见
expect(await page.locator("[data-testid=alert]")).toBeVisible();
```

### 2. 视觉断言（截图比对）

用于结构断言覆盖不到的场景（图表、样式、布局）：

```ts
// 方式一：像素级 diff（确定性，脆弱）
await expect(page).toHaveScreenshot("dashboard.png", { maxDiffPixels: 100 });

// 方式二：视觉模型语义断言（鲁棒，模糊）
const screenshot = await page.screenshot();
const passed = await visualAssert(screenshot, "页面显示折线图，X 轴为日期");
```

视觉模型断言 prompt：

```
当前截图（附上）。
判断以下条件是否满足：{criteria}
只回答 JSON：{"passed": true/false, "reason": "..."}
```

---

## 测试用例格式

```json
{
  "id": "checkout_flow",
  "description": "用户完成商品结算",
  "steps": [
    { "action": "navigate", "url": "https://shop.example.com/cart" },
    { "action": "click",    "locator": { "strategy": "text", "value": "去结算" } },
    { "action": "fill",     "locator": { "strategy": "css", "value": "#email" }, "value": "test@example.com" },
    { "action": "click",    "locator": { "strategy": "text", "value": "提交订单" } },
    { "action": "assert",   "type": "text_contains", "value": "订单已提交" },
    { "action": "assert",   "type": "visual", "criteria": "页面显示订单确认信息和订单号" }
  ]
}
```

也支持自然语言描述，由 agent 自动拆解步骤：

```json
{
  "id": "checkout_nl",
  "input": "进入购物车，完成结算，验证订单提交成功",
  "eval": "visual",
  "criteria": "最终页面显示订单确认"
}
```

---

## 自动生成测试用例

给 agent 提供页面 URL 或设计稿，自动生成覆盖主路径和边界情况的用例：

```
prompt: 访问 {url}，分析页面功能，生成覆盖以下场景的测试用例：
        1. 主流程（Happy Path）
        2. 表单验证（空值、格式错误、边界值）
        3. 权限边界（未登录访问、越权操作）
        4. 错误处理（网络断开、服务报错）
        以 JSON 数组返回，格式为 TestCase[]
```

生成后人工审核，加入回归集。

---

## WebMCP 支持

接入 [WebMCP](https://github.com/google/web-mcp)（Google 官方 MCP 浏览器协议），标准化浏览器操作接口：

```
Testing Agent → MCP Client → WebMCP Server（浏览器扩展 / CDP）→ 真实页面
```

优势：
- 标准 MCP 接口，切换浏览器 backend 无需改测试代码
- 支持 accessibility tree，元素定位比纯截图更准确
- Google 官方维护，与 Chrome 深度集成

配置（`.vera/settings.json`）：

```json
{
  "browser": {
    "provider": "webmcp",
    "webmcp": { "server_url": "ws://localhost:9222/mcp" }
  }
}
```

也支持直接使用 Playwright（无需扩展）：

```json
{
  "browser": {
    "provider": "playwright",
    "playwright": { "browser": "chromium", "headless": true }
  }
}
```

---

## 桌面应用测试

对于无法用浏览器访问的原生应用：

```
截图 → agent 分析当前状态 → 决定下一步动作 → 执行 → 截图确认 → ...
```

动作类型：

```ts
type DesktopAction =
  | { type: "screenshot" }
  | { type: "click";        x: number; y: number }
  | { type: "double_click"; x: number; y: number }
  | { type: "type";         text: string }
  | { type: "key";          keys: string }       // "cmd+c", "enter"
  | { type: "find_element"; description: string } // 返回坐标
  | { type: "scroll";       x: number; y: number; delta: number }
```

macOS：`screencapture` + `cliclick`
跨平台：`nut-js`（Node.js）

---

## 测试报告

每条 StepResult 记录：

```json
{
  "step_id": "checkout_flow/3",
  "action": "click",
  "locator_strategy_used": "text",
  "locator_strategies_tried": ["accessibility_id", "xpath", "text"],
  "screenshot_before": "base64...",
  "screenshot_after": "base64...",
  "passed": true,
  "duration_ms": 320
}
```

报告格式：
- **JSONL**：每步一行，方便 grep 分析
- **HTML**：带截图的可视化报告，标注每步通过/失败状态
- **Markdown**：CI 评论用

---

## 与 Benchmark 的边界

| | Testing（本文档） | Benchmark |
|---|---|---|
| 目标 | 测 UI 交互是否正确 | 测 agent 能力强弱 |
| 输入 | 页面 URL / 应用 | 自然语言任务 |
| 断言 | 元素状态、截图 | 文本输出、工具调用 |
| 依赖 | 浏览器 / 桌面环境 | LLM API |
