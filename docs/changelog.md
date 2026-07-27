# Changelog — Entry Index

After each commit, append a summary to this file. Detailed content goes into `docs/changelog/<date>-<hour>.md`.

## Format Rules

- **date-hour**: use the commit time in `YYYY-MM-DD-HH` format
| 2026-06-05 · 01:xx | v0.3.3: Anthropic prompt caching cache_control, logger default info, VitePress 文档站 | [→](./changelog/2026-06-05-01.md) |
- **Summary**: one sentence, max 80 characters
- **Detail file**: commit table, Roadmap sync, outstanding items

---

| Date Batch | Summary | Detail |
|---|---|---|
| 2026-07-27 · 19:xx | feat(partner): Host 化落地 + turn 时序转录，修三个协议级缺陷 | [→](./changelog/2026-07-27-19-partner-host-turn-timeline.md) |
| 2026-07-27 · 10:xx | fix(partner): 修复 ACL 拦截致功能大面积失效，历史迁移与死代码清理 | [→](./changelog/2026-07-27-10-partner-acl-recovery.md) |
| 2026-07-25 · 17:xx | fix(partner): 大图附件自动压缩生成可预览缩略图 | [→](./changelog/2026-07-25-17-partner-image-compress.md) |
| 2026-07-25 · 17:xx | feat(partner): VS Code 式 Workbench Host 推倒重来 | [→](./changelog/2026-07-25-17-partner-host.md) |
| 2026-07-25 · 16:xx | fix(partner+core): 上下文用量对齐远端窗口，驱动本地压缩 | [→](./changelog/2026-07-25-16-partner-context-occupancy.md) |
| 2026-07-25 · 16:xx | feat(partner): 底部终端 + 顶栏入口 + 会话 cwd | [→](./changelog/2026-07-25-16-partner-terminal.md) |
| 2026-07-25 · 15:xx | feat(partner): 文件树右键（新建/显示/复制/剪切/重命名/删除） | [→](./changelog/2026-07-25-15-partner-file-ops.md) |
| 2026-07-25 · 15:xx | feat(partner): 全局搜索（文件+会话，Cmd+P/侧栏共用） | [→](./changelog/2026-07-25-15-partner-quick-open.md) |
| 2026-07-25 · 15:xx | feat(partner): Markdown 右键预览 | [→](./changelog/2026-07-25-15-partner-md-preview.md) |
| 2026-07-25 · 15:xx | fix(partner): 模型下拉被输入栏裁切 | [→](./changelog/2026-07-25-15-partner-model-menu.md) |
| 2026-07-25 · 15:xx | feat(partner): 上下文窗口圆环 + 运行统计 tooltip | [→](./changelog/2026-07-25-15-partner-context-usage.md) |
| 2026-07-25 · 15:xx | feat(partner): 全局性能埋点（超时/卡死/掉帧） | [→](./changelog/2026-07-25-15-partner-perf.md) |
| 2026-07-25 · 15:xx | feat(partner): 大模型设置对齐 Vera（改名/models/routing） | [→](./changelog/2026-07-25-15-partner-llm-align.md) |
| 2026-07-25 · 14:xx | feat(partner): 多项目布局方案定稿 + P1 全局 app-state 数据层 | [→](./changelog/2026-07-25-14-multi-project.md) |
| 2026-07-25 · 14:xx | ci(partner): PR 轻量检查 + tag/手动 macOS 打包 Release | [→](./changelog/2026-07-25-14-partner-ci.md) |
| 2026-07-25 · 14:xx | feat(partner): 顶栏更紧凑、页签关闭交互、跟随主题隐藏通透度 | [→](./changelog/2026-07-25-14.md) |
| 2026-07-25 · 12:xx | feat(partner): 主题/壁纸玻璃 UI、自定义色阶提取与浅色可读性 | [→](./changelog/2026-07-25-12.md) |
| 2026-07-07 · 20:xx | feat(core+partner): OpenAI Responses API adapter，四层协议打通（core/sidecar/tauri/UI） | [→](./changelog/2026-07-07-20.md) |
| 2026-06-05 · 00:xx | docs: VitePress documentation site launched, bilingual EN/ZH, 9 new feature docs, sidebar restructure | [→](./changelog/2026-06-05-00.md) |
| 2026-06-04 · 23:xx | v0.3.1 release: NODE_ENV injection in production builds, default log level info | [→](./changelog/2026-06-04-23.md) |
| 2026-06-04 · 21:xx | v0.3.0 release: Claude Code migration config, resource sync, dev source debugging | [→](./changelog/2026-06-04-21.md) |
| 2026-05-28 · 19:xx | REPL live output + setup wizard + CubeSandbox + thinking/reasoning token support | [→](./changelog/2026-05-28-19.md) |
| 2026-05-27 · 23:xx | Phase 17 AD4+AD5: A/B Testing (25 tests) | [→](./changelog/2026-05-27-23c.md) |
| 2026-05-27 · 23:xx | Phase 17 AD3: Auto-Tuner (37 tests) | [→](./changelog/2026-05-27-23b.md) |
| 2026-05-27 · 23:xx | Phase 17 AD2: Historical Success Rate (17 tests) | [→](./changelog/2026-05-27-23.md) |
| 2026-05-27 · 22:xx | Phase 17 AD1: Strategy Store (44 tests) | [→](./changelog/2026-05-27-22.md) |
| 2026-05-27 · 21:xx | Phase 16 CH4: API Channel (30 tests) | [→](./changelog/2026-05-27-21.md) |
| 2026-05-27 · 20:xx | Phase 16 CH1-CH3: Channel abstraction + Gateway + CLI (97 tests) | [→](./changelog/2026-05-27-20b.md) |
| 2026-05-27 · 14:xx | Phase 9 SQ4: Session storage migration (10 tests) | [→](./changelog/2026-05-27-14.md) |
| 2026-05-27 · 10:xx | Phase 7-8: Memory + Skill enhancement (62 tests) | [→](./changelog/2026-05-27-10.md) |
| 2026-05-10 · 14:xx | Feature branch core: checkpoint/resume, memory, tool runtime, P0 tests (25 commits) | [→](./changelog/2026-05-10-14.md) |
| 2026-04-28 · 12:xx | P0 alignment wrap-up: CLI theme, pre-commit scanning, docs overhaul | [→](./changelog/2026-04-28-12.md) |
