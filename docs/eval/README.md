# Eval — 评测与测试文档

评测体系负责量化 Vera 在各类任务上的完成率、工具准确率和稳定性，是自我进化闭环的基础。

## 文档目录

| 文档 | 内容 |
|---|---|
| [benchmark.md](./benchmark.md) | Benchmark 方案——评估维度、开源评测集（GAIA/SWE-bench/ToolBench）、运行时机 |

## 主要包结构

```
packages/benchmark/src/
  index.ts          示例 case 集 + runSuite + evaluate（当前为示例代码）
```

## 当前状态

`@vera/benchmark` 目前只有示例代码，尚未对接实际 agent 运行。

## 待实现（P2）

- Case 从文件加载（JSON / YAML）
- 并发执行 + 吞吐控制
- `exact / contains / tool_match / llm_judge` 四种评估模式
- 报告生成与 trend 追踪
- 与 Dreaming / Proposal Pipeline 打通
