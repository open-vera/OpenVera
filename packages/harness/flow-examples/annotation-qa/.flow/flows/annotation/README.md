# 内容标注

## 职责

标注员按照标注规范对预处理后的数据逐条进行标注。

## 参与角色

- **annotator**: 主导标注执行，记录问题和边界案例

## 输入

- 数据预处理产物: [flows/preprocessing/output/](../preprocessing/output/)

## 交付产物（写入数据集目录）

写入 `../dataset/annotated/`：

- `annotations.jsonl` — 标注结果文件（每行一条，含原始内容和标注标签）
- `annotation-log.md` — 标注日志（处理数量、跳过记录、边界案例列表）

## 步骤记录（写入 output/）

写入本目录 `output/`：

- `summary.md` — 执行摘要（标注完成量、遇到的问题、边界案例总结、给质检的注意事项）

## 准出标准

- 全部数据标注完成（跳过项有说明）
- 标注结果格式符合 output-format.md 规范
- 边界案例有记录并标注（不随意猜测）
- 标注日志记录完整（时间戳、数量、问题项）
- 最低得分: 0.8
