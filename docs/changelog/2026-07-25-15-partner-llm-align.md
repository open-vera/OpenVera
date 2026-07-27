# 2026-07-25 · 15:xx — Partner 大模型设置对齐 Vera

## 变更

| Hash | 模块 | 内容 |
|---|---|---|
| (pending) | partner | Provider 可改名；models 别名 + default_model + routing UI；inspect/save 扩展；sidecar 尊重 file routing |

## Roadmap 同步

- 无（Partner UX / 配置对齐，非 P0/P1 checkbox）

## 遗留事项

- `session.ai_title` / `session.compact` 仍走「编辑 JSON」
- 需重启 Partner 以加载新的 Tauri 命令（`rename_vera_provider` / `save_vera_models_routing`）
