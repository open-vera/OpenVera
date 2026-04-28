# 生产环境可行性分析

> 评估本地 ASR + LLM 方案在生产级别（1000 文件、2-10 小时音频）的可行性。

## 硬件基准

以 MacBook Pro M4 Pro 24GB 为参考基准（开发/测试常见配置）。

## ASR 阶段 — 可行

### 性能数据

Qwen3-ASR 0.6B (MLX) 实测 RTFx ≈ 12-20x（即 1 分钟音频 3-5 秒处理）：

| 场景 | 音频总量 | 预估 ASR 时间 | 内存占用 |
|------|----------|--------------|----------|
| 1000 × 1 分钟 | 16.7 小时 | ~1-1.5 小时 | ~1.2GB（模型固定） |
| 100 × 10 分钟 | 16.7 小时 | ~1-1.5 小时 | ~1.2GB |
| 10 × 2 小时 | 20 小时 | ~1-1.7 小时 | ~1.2GB |
| 1 × 10 小时 | 10 小时 | ~50-85 分钟 | ~1.2GB |

**结论**：ASR 阶段没有问题。0.6B 模型轻量（~1.2GB），MLX 推理高效，长音频也只是线性增长。如果需要更高精度可用 1.7B（~3.4GB），24GB 内存仍然宽裕。

### 长音频注意事项

- Qwen3-ASR 和 Parakeet 支持流式处理，不需要一次性加载整段音频到内存
- VibeVoice 原生支持 60 分钟长音频，更长的需要分段
- Gemma 4 有 30 秒硬限制，不适合长音频

## LLM 阶段 — 有硬约束，需要分块策略

### 核心问题

| 约束 | 详细说明 | 影响 |
|------|----------|------|
| **Context window** | 本地模型通常 8K-32K tokens，2h 对话 ≈ 36K tokens 已超限 | 长音频文本无法整体送入 |
| **内存** | qwen3.5:9b ≈ 6GB + KV cache 随输入长度膨胀 | 24GB 机器长文本会 OOM |
| **Prefill 速度** | 长输入的 prefill 时间线性增长，32K tokens ≈ 20-40 秒 | 单次调用就很慢 |
| **输出质量** | 输入过长时模型注意力分散，纠错/分类质量下降 | 准确率不可靠 |

### 文本量估算

中文对话平均语速 ~200 字/分钟：

| 音频时长 | 文本量 | Token 数（约） | 能否直接送入 LLM |
|----------|--------|---------------|------------------|
| 1 分钟 | ~200 字 | ~300 | ✅ 完全 OK |
| 5 分钟 | ~1,000 字 | ~1,500 | ✅ 轻松 |
| 30 分钟 | ~6,000 字 | ~9,000 | ⚠️ 接近 8K 上限 |
| 2 小时 | ~24,000 字 | ~36,000 | ❌ 超出大多数模型 |
| 10 小时 | ~120,000 字 | ~180,000 | ❌ 完全不可行 |

### 解决方案：分块处理（Chunking）

长音频的 LLM 处理必须按块进行。利用 ASR 已有的 segments 作为天然切分点：

```
10h 音频
  │
  ├─ ASR 转写 → 完整文本 + segments（带时间戳）
  │
  ├─ Chunker 按 segments 聚合为 chunks
  │   规则：每个 chunk ≤ 2000 字（~3000 tokens）
  │         在 segment 边界切分，不打断句子
  │         相邻 chunk 重叠 1-2 个 segment（保持上下文）
  │
  └─ 每个 chunk 独立 LLM 处理 → 合并结果
```

#### Chunk 大小选择

| Chunk 大小 | Tokens | 优点 | 缺点 |
|-----------|--------|------|------|
| 500 字 | ~750 | 极快，LLM 质量最好 | chunk 数多，合并开销大 |
| **2000 字** | ~3000 | **平衡点**：LLM 质量好 + chunk 数可控 | — |
| 5000 字 | ~7500 | chunk 数少 | 接近 8K 上限，质量可能下降 |

**推荐 2000 字/chunk**，2 小时音频 ≈ 12 个 chunk，10 小时 ≈ 60 个 chunk。

#### 各任务的分块策略

| 任务 | 分块方式 | 合并方式 |
|------|----------|----------|
| 纠错 | 按 chunk 独立纠错 | 直接拼接（重叠区去重） |
| 说话人分离 | 按 chunk 独立分离 | 跨 chunk 的同一说话人需对齐合并 |
| 内容标签 | 全文级别，取第一个 chunk 或每 N 个 chunk 采样 | 投票合并 |
| 质量评分 | 按 chunk 独立评分 | 直接合并 |
| 翻译 | 按 chunk 独立翻译 | 直接拼接 |
| 分句 | 按 chunk 独立分句 | 直接拼接 |

#### 说话人跨 chunk 对齐

说话人分离的跨 chunk 合并需要特殊处理：

```
Chunk 1 识别出：[说话人A=店员] [说话人B=顾客]
Chunk 2 识别出：[说话人A=顾客] [说话人B=店员]  ← 标签可能翻转

解决：利用重叠区的文本匹配说话人身份
```

方案：
1. 相邻 chunk 重叠 2 个 segment
2. 对比重叠区说话人标签，建立映射关系
3. 如果有具体称呼（"爸"、"老师"），以称呼为准全局统一

#### 内容标签的采样策略

10 小时音频不需要每个 chunk 都打标签，采样即可：

```python
def sample_chunks_for_tagging(chunks: list[str], max_samples: int = 3) -> list[str]:
    """均匀采样 chunks 用于内容标签生成"""
    if len(chunks) <= max_samples:
        return chunks
    # 取开头、中间、结尾各一个
    indices = [0, len(chunks) // 2, len(chunks) - 1]
    return [chunks[i] for i in indices]
```

对采样结果做投票合并：多个 chunk 都识别为"餐厅"则确认，冲突的取多数。

## 完整流水线时间预估

### 场景一：1000 × 1 分钟文件

```
ASR（串行）：  1000 × 4s   = ~67 分钟
LLM（3 并发）：1000 × 15s / 3 = ~83 分钟
流水线重叠后：  ~90 分钟（1.5 小时）
```

### 场景二：10 × 2 小时文件

```
每个文件：
  ASR：    2h ÷ 15x RTF = ~8 分钟
  Chunk：  12 chunks × 15s / 3 并发 = ~1 分钟
  总计：   ~9 分钟/文件

10 个文件流水线：~80 分钟（1.3 小时）
```

### 场景三：1 × 10 小时文件

```
ASR：     10h ÷ 15x RTF = ~40 分钟
Chunk：   60 chunks × 15s / 3 并发 = ~5 分钟
合并：    ~1 分钟
总计：    ~46 分钟
```

## 内存预算

### 24GB 机器

```
系统 + 桌面          ~5 GB
ASR 模型（0.6B）      ~1.2 GB
Ollama 模型（9B）     ~6 GB
KV cache（3K tok）    ~0.5 GB
余量                  ~11 GB  ✅ 宽裕
```

### 8GB 机器（最低配置）

```
系统 + 桌面          ~4 GB
ASR 模型（0.6B）      ~1.2 GB
Ollama 模型（4B）     ~2.5 GB  ← 只能用 gemma3:4b
KV cache             ~0.3 GB
余量                  ~0 GB   ⚠️ 极限，需要串行不能并行
```

**结论**：
- 24GB+ 可以 ASR + LLM 同时加载，流水线并行
- 16GB 可以流水线并行，但推荐用较小 LLM（qwen3:8b 或 gemma3:4b）
- 8GB 只能串行（先 ASR 全部完成卸载模型，再加载 LLM），且只能用 4B 模型

## 可靠性设计

生产环境跑 1000 个文件 1-2 小时，必须考虑中断恢复：

### 断点续传

```python
@dataclass
class AnnotationCheckpoint:
    """标注检查点，支持断点续传"""
    total_files: int
    completed_asr: list[str]        # 已完成 ASR 的文件路径
    completed_llm: list[str]        # 已完成 LLM 的文件路径
    pending_files: list[str]        # 待处理文件
    partial_results: list[dict]     # 已有结果
    timestamp: str
```

**策略**：
- 每完成一个文件的全部处理，立即写入 checkpoint 文件
- 程序重启后读取 checkpoint，跳过已完成的文件
- checkpoint 文件存储在输出目录，与结果文件同级

### 错误隔离

```python
# 单文件 LLM 失败不影响整批
for chunk in chunks:
    try:
        result = await llm_process(chunk)
    except Exception as e:
        log(f"LLM 处理失败（chunk {i}）：{e}，跳过")
        result = LLMResult(error=str(e))  # 标记为失败，保留 ASR 原始结果
```

- LLM 单个 chunk 失败：标记为未处理，保留 ASR 原始结果
- Ollama 崩溃/超时：自动重试 1 次，仍失败则跳过该 chunk
- 内存不足（OOM）：Load Monitor 检测到后自动降级（减少并发/切换小模型）

### 增量导出

不等全部完成再导出，每处理完一个文件立即追加到结果文件：

```python
# 流式写入 JSONL（每行一个 JSON 对象）
with open(output_path, "a") as f:
    f.write(json.dumps(record, ensure_ascii=False) + "\n")
```

最终导出时再转为完整 JSON 数组或 CSV。好处：即使中途中断也不丢已完成的结果。

## 结论与建议

| 维度 | 结论 |
|------|------|
| ASR | ✅ 完全可行，无瓶颈 |
| LLM（短音频 <10min） | ✅ 直接处理，无需分块 |
| LLM（长音频 2-10h） | ⚠️ 必须分块，2000 字/chunk |
| 内存（24GB） | ✅ 流水线并行无压力 |
| 内存（8GB） | ⚠️ 仅串行 + 4B 模型 |
| 1000 文件吞吐 | ✅ 约 1.5 小时可完成 |
| 可靠性 | 需要 checkpoint + 错误隔离 + 增量导出 |

### 实施状态

| 优先级 | 内容 | 状态 |
|--------|------|------|
| P1 | 分块处理器（Chunker） | ✅ 已实现，`_chunk_segments` + `label_transcript` 自动分块，阈值 2000 字 |
| P2 | 断点续传（checkpoint） | ✅ 已实现，`.checkpoint.json` 按文件 hash 匹配，重启后跳过已完成文件 |
| P3 | 增量导出 | ✅ 已实现，每个 `file_done` 事件触发立即追加 `records.jsonl` |
| P4 | 内存感知降级 | ⚠️ 部分：`LoadMonitor` 已实现动态降低 `llm_workers`，缺自动切换小模型逻辑 |

P1 分块是长音频场景的前提，目前线上跑 >10 分钟音频会直接把全文推给 LLM，
遇到长音频有 context 超限风险。
