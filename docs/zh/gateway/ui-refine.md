# UI 优化方案

> 目标：在 Harness Web UI 现有骨架基础上，提升视觉一致性、交互流畅度、可访问性和响应式体验。

## 当前状态基线

Gateway Web UI 已具备基础 Run 列表、Run 详情、Memory/Checkpoint/Subagent 视图。本节聚焦 UI 质量提升，不新增业务页面。

## 主题系统

### 设计原则

- 以 TDesign 设计令牌为基础，扩展 Vera 品牌色和语义色
- 所有颜色通过 CSS 变量引用，禁止硬编码颜色值
- 支持深色 / 浅色双主题，跟随系统偏好或手动切换

### 令牌层级

```
:root {
  /* 品牌色 */
  --vera-brand:             rgb(215, 119, 87);    /* Vera 橙 */
  --vera-brand-hover:       rgb(235, 159, 127);   /* 悬停高亮 */
  --vera-brand-active:      rgb(195, 99, 67);     /* 按下态 */

  /* 语义色 */
  --vera-success:           rgb(78, 186, 101);    /* 成功 */
  --vera-error:             rgb(255, 107, 128);   /* 错误 */
  --vera-warning:           rgb(255, 193, 7);     /* 警告 */

  /* 文字层级 */
  --vera-text-primary:      rgba(0, 0, 0, 0.9);
  --vera-text-secondary:    rgba(0, 0, 0, 0.6);
  --vera-text-placeholder:  rgba(0, 0, 0, 0.4);
  --vera-text-disabled:     rgba(0, 0, 0, 0.26);

  /* 背景 */
  --vera-bg-base:           rgb(255, 255, 255);
  --vera-bg-container:      rgb(247, 247, 247);
  --vera-bg-elevated:       rgb(255, 255, 255);

  /* 间距 */
  --vera-space-xs: 4px;
  --vera-space-sm: 8px;
  --vera-space-md: 16px;
  --vera-space-lg: 24px;
  --vera-space-xl: 32px;
}
```

### 深色主题覆写

```css
[theme-mode="dark"] {
  --vera-text-primary:      rgba(255, 255, 255, 0.9);
  --vera-text-secondary:    rgba(255, 255, 255, 0.6);
  --vera-bg-base:           rgb(26, 26, 26);
  --vera-bg-container:      rgb(34, 34, 34);
  --vera-bg-elevated:       rgb(42, 42, 42);
}
```

## 组件精炼

### Run 卡片优化

- 状态指示器使用脉冲动画（running 态）
- 添加相对时间显示（"3 分钟前"、"1 小时前"替代绝对时间戳）
- Tool 调用计数和 Token 消耗在卡片上直接可见
- 长标题截断 + tooltip 悬停完整显示

### 时间线组件

- 阶段切换动画：当前阶段高亮 + 完成阶段变灰，过渡 200ms ease
- 步骤折叠 / 展开：默认展开最后 N 步，其余折叠
- 工具调用内联预览：单行截断，点击展开完整 JSON
- 虚拟滚动：Run 超过 100 步时启用，保持渲染性能

### 状态面板

- 空状态插画 + 引导文案（无 Run / 无 Checkpoint / 无 Memory）
- 加载骨架屏：ListItem 占位形状 + shimmer 动画
- 错误状态：友好错误消息 + 重试按钮
- 滚动位置记忆：切换 Tab 后返回时恢复滚动位置

### 输入组件

- 多行输入框，支持 Shift+Enter 换行
- Slash 命令面板：输入 `/` 触发下拉菜单（/flow、/model、/provider）
- 历史记录：ArrowUp/ArrowDown 浏览已发送消息
- 字符计数：在输入框右下角显示当前字符数 / 上限

## 交互改进

### 键盘导航

- `Ctrl+K` / `Cmd+K` 打开命令面板（全局搜索、页面跳转）
- `Ctrl+[` / `Ctrl+]` 切换侧边栏
- `Esc` 关闭弹窗 / 下拉菜单 / 命令面板
- `j` / `k` 在列表中上下导航
- `Enter` 确认选择
- `?` 显示键盘快捷键清单

### 响应式布局

| 断点 | 宽度 | 布局 |
|---|---|---|
| Mobile | < 768px | 单栏，侧边栏抽屉式，表格转卡片 |
| Tablet | 768px - 1024px | 双栏，侧边栏可收起 |
| Desktop | > 1024px | 三栏（导航 + 内容 + 详情面板） |

运行中收缩窗口时，自动折叠次要面板，优先保持时间线和内容可见。

### 过渡与反馈

- 页面切换：Route transition 200ms fade
- 列表更新：新增条目淡入 (opacity 0 → 1)
- 删除操作：滑出动画 + toast 确认
- 长时间操作（Run 启动、RAG 重建索引）：Loading overlay + 进度指示
- 复制按钮：Tool call args / 代码块右上角一键复制，操作后按钮变 ✓ 1 秒

## 可访问性

- 所有交互元素支持 `Tab` 聚焦，焦点环可见（`:focus-visible` 轮廓 2px 品牌色）
- 图标配合 `aria-label` 提供屏幕阅读器文本
- 表格使用 `<thead>` / `<tbody>` + `scope` 属性
- 状态色不依赖单一颜色表达（running 状态同时使用图标 + 文字 + 颜色）
- 目标区域不小于 44x44px（移动端触摸友好）

## 性能预算

- 首屏加载（LCP）< 2.5 秒
- 交互响应（INP）< 200ms
- Run 列表虚拟滚动阈值：100 条以上启用
- API 数据请求合并：列表页一次请求获取 30 条，滚动加载更多
- 图片/图标使用 SVG sprite 或 icon font 减少请求数

## 实施优先级

1. **P0**：主题系统 + 空状态 / 加载态 / 错误态
2. **P1**：键盘导航 + 响应式布局
3. **P2**：动画过渡 + 虚拟滚动
4. **P3**：可访问性审计 + 深色主题优化
