# Changelog — 入口索引

每次提交后，将本批次摘要追加到此文件，详细内容写入 `docs/changelog/<date>-<hour>.md`。

## 格式规则

- **date-hour**：取 commit 时间的 `YYYY-MM-DD-HH`（同一小时内多次提交合并为一条）
- **摘要**：一句话说明本批次做了什么，不超过 80 字
- **详细文件**：包含 commit 表格、Roadmap 同步说明、遗留事项

---

| 日期批次 | 摘要 | 详细 |
|---|---|---|
| 2026-04-28 · 12:xx | P0 对齐收尾：CLI 主题、pre-commit 扫描、background subagent 接口、quality-scan skill、docs 全面更新 | [→](./changelog/2026-04-28-12.md) |
| 2026-04-29 · 11:xx | Smoke 入口统一：修复 loop 空回复重试 bug、新增 REPL loop smoke test、统一 smoke suite 入口 | [→](./changelog/2026-04-29-11.md) |
