# 2026-07-25 · 16:xx — Partner 底部终端

## 变更

| Hash | 模块 | 内容 |
|---|---|---|
| (pending) | partner-tauri | `portable-pty`：`pty_spawn` / `pty_write` / `pty_resize` / `pty_kill` + 事件流 |
| (pending) | partner | 底部多标签终端（xterm），Ctrl/Cmd+` 开关，布局高度可拖 |
| (pending) | partner | 新建 tab cwd 绑定当前会话项目根；入口改到左侧顶栏 |
| (pending) | partner | 顶栏 tab 激活后横向滚入视野；Cmd+N 走 app-state 建会话 |

## Roadmap 同步

- 无

## 遗留事项

- 暂无分屏 / 选择默认 shell 设置
- 关闭最后一个标签会收起面板；关闭面板本身保留会话（v-show）
- 已运行的 PTY 不随会话切换改 cwd；仅新建 tab 使用当前会话项目目录
- 终端入口在左侧顶栏（搜索/历史旁），快捷键仍为 Ctrl/Cmd+`
