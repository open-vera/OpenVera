# 2026-04-04 讨论纪要：平台切换 + LLM 标注 + UI 优化

> 本文整理 2026-04-04 的讨论内容，包含已完成的改动和待实施的方案。

## 一、已完成的改动

### 1.1 转写面板 Loading 状态

**问题**：转写进行中，右侧"转写内容"区域一片空白，用户无反馈。

**改动**：当选中文件尚无转写结果且标注进行中时，显示 spinner + "正在转写中，请稍候..."。

**文件**：`gui/src/lib/ResultsView.svelte`

### 1.2 逐字高亮范围修复

**问题**：播放时一大段文字同时高亮，不是逐字跟随。

**根因**：`segTokens()` 用 `split(/\s+/)` 分词，中文文本几乎无空格，整段变成一个 token 共享一个时间范围。

**修复**：当有 word 级时间戳时，直接使用 ASR 返回的 words 数据，不做多余的 token 匹配。

**文件**：`gui/src/lib/ResultsView.svelte` — `segTokens()` 函数

### 1.3 Segments 后处理断句

**问题**：ASR 模型原始 chunks 粒度太粗（54s 音频只分 3 段，每段 15-20s），阅读和导航体验差。

**分析**：业界主流做法是 ASR 拿到逐字时间戳后做后处理断句（按标点+停顿切分），而非依赖模型原始分块。剪映、飞书妙记、Otter.ai 均采用此方案。

**改动**：
- 数据模型新增 `chunks` 字段保留模型原始分块
- `segments` 改为后处理断句结果（基于 words 时间戳 + 标点/停顿规则）
- 断句后仍对 segment 文本做 jieba 分词加空格

**三层数据结构**：

| 字段 | 内容 | 来源 |
|------|------|------|
| `chunks` | 模型原始分块 | ASR 直出，保留原貌 |
| `segments` | 后处理断句 | 基于 words + `_merge_segments` + jieba |
| `words` | 逐字时间戳 | ASR 直出，用于逐字高亮 |

**文件**：
- `src/audio_label/transcribers/__init__.py` — TranscribeResult 增加 chunks
- `src/audio_label/transcribers/qwen3.py` — 重构 transcribe()
- `src/audio_label/annotator.py` — AnnotationRecord 增加 chunks
- `gui/src/lib/api.ts` — AnnotationResult 增加 chunks

### 1.4 CSV 导出完整数据

**问题**：CSV 只有 5 个扁平字段（file, text, language, duration_sec, sample_rate），segments/words/chunks 全丢了。

**改动**：新增 segments、words、chunks 三列，值为 JSON 字符串。

**文件**：`src/audio_label/exporter.py`

---

## 二、待实施方案

### 2.1 Feature A：ASR 平台切换（MLX / Ollama）

**背景**：用户已安装 Ollama 及多个模型（qwen3.5:9b, qwen3:8b, gemma3:4b, qwen3-vl:8b），预检也已能检测到。但当前 ASR 只走 MLX/Transformers。

**决策**：合并展示。不加单独的"平台"选择器，而是在后端下拉中直接展示平台信息：

```
ASR 设置
├── Qwen3-ASR 0.6B (MLX)
├── Qwen3-ASR 1.7B (MLX)
├── Parakeet TDT 0.6B (MLX)
├── Qwen3-VL 8B (Ollama)        ← 从 ollama list 动态获取
└── ...
```

只有多模态模型（含 vl、vision、llava 等关键词）出现在 ASR 列表中，文本模型仅用于 LLM 标注。

**后端编码**：
- MLX 后端：`"qwen3"`, `"parakeet"` 等（不变）
- Ollama 后端：`"ollama:qwen3-vl:8b"` — 前缀 `"ollama:"` + 模型名

**新增文件**：
- `src/audio_label/ollama.py` — Ollama HTTP 客户端（chat、list、audio base64）
- `src/audio_label/transcribers/ollama_asr.py` — OllamaTranscriber

**修改文件**：
- `src/audio_label/transcribers/__init__.py` — 工厂函数识别 `"ollama:"` 前缀
- `src/audio_label/server.py` — 新增 `GET /api/ollama-models`，`/api/annotate` 接受 Ollama 后端
- `src/audio_label/config.py` — 新增多模态模型关键词

**注意**：Ollama ASR 无 word 级时间戳，前端已有降级逻辑（`segTokens` 均匀分配时间）。

### 2.2 Feature B：LLM 自定义标注

> 详细的 LLM 后处理方案见 [llm-post-processing.md](./llm-post-processing.md)，此处记录本次讨论确定的关键决策。

#### 标注粒度

**决策**：整文件为主 + segment 上下文。

即：将完整转写文本连同 segment 时间戳结构一起发送给 LLM，一次调用获得全文级和段落级标注结果。不逐 segment 单独调用。

Prompt 中的文本格式：

```
[0:00 - 0:03] 你好，吃点啥？
[0:03 - 0:05] 爸，吃啥？
[0:05 - 0:08] 自己点，来个榴莲披萨。
...
```

#### 提示词管理

**决策**：沿用现有 `prompts/*.md` 本地文件夹方案。

- 用户直接往文件夹放 `.md` 文件即可
- UI 提供"打开提示词文件夹"按钮
- 内置预设模板（纠错、说话人分离、内容标签、质量评分、翻译等，详见 llm-post-processing.md）
- 导入/导出天然支持（文件就是导出物）

#### 标注流程

ASR 和 LLM 标注是两个独立步骤：

```
选文件 → 配置(ASR+LLM) → ASR 转写 → 查看转写 → [可选] LLM 标注 → 查看标注
```

- ASR 完成后自动展示转写结果
- LLM 标注按需手动触发（单文件或批量）
- 支持重复标注（换提示词/模型后重新运行）

**新增文件**：
- `src/audio_label/labeler.py` — `label_transcript()` 函数
- `gui/src/lib/AIAnnotationPanel.svelte` — AI 标注面板组件

**新增 API**：
- `POST /api/label` — 同步，单文件 LLM 标注

**数据模型扩展**：

```python
@dataclass
class LabelResult:
    prompt_name: str
    model: str
    result: str
    segment_labels: list[dict] | None = None

# AnnotationRecord 新增
labels: list[LabelResult] = field(default_factory=list)
```

### 2.3 ConfigBar 分区布局

**决策**：配置区分为两个明确标注的区域。

```
┌─ ASR 设置 ─────────────────────┬─ LLM 标注 ────────────────────────┐
│  模型 [Qwen3-ASR 0.6B (MLX) ▼] │  模型 [qwen3.5:9b ▼]             │
│  格式 [JSON ▼]                  │  提示词 [默认 ▼]                  │
│                                 │  (Ollama 未连接时显示禁用提示)     │
└─────────────────────────────────┴────────────────────────────────────┘
```

- ASR 区：合并后端+模型为一个下拉（含平台标识），格式选择
- LLM 区：Ollama 模型下拉，提示词下拉
- Ollama 不可用时，LLM 区整体置灰 + 提示文案

**文件**：`gui/src/lib/ConfigBar.svelte`

### 2.4 ResultsView 四列布局

**决策**：AI 标注作为独立列，不和手动标注 tab 切换。

```
┌──文件列表──┬───转写内容───┬──AI 标注──┬──手动标注──┐
│  280px     │   flex: 1   │  300px   │  260px    │
│  (加宽)    │   (不变)     │  (新增)   │  (条件)   │
└────────────┴─────────────┴──────────┴───────────┘
```

#### 文件列表加宽 (220px → 280px)

新增展示信息：
- 文件大小（KB/MB）
- 音频时长
- ASR 状态 + LLM 标注状态

#### AI 标注面板 (300px)

状态流转：

| 状态 | 展示 |
|------|------|
| 未选模型 | "请在配置中选择 LLM 模型" |
| 有模型，无结果 | "运行标注" 按钮 |
| 标注中 | spinner + "标注中..." |
| 完成 | LLM 返回文本 + 模型/提示词信息 + "重新标注" |

顶部栏增加"批量 AI 标注"按钮，逐文件调用，显示进度。

#### 手动标注面板 (260px, 条件显示)

保持现有逻辑不变（有标注时显示）。

**文件**：
- `gui/src/lib/ResultsView.svelte` — 布局调整
- `gui/src/lib/AIAnnotationPanel.svelte` — 新组件

---

## 三、文件变更清单

### 已完成

| 文件 | 改动 |
|------|------|
| `gui/src/lib/ResultsView.svelte` | loading 状态、高亮修复 |
| `src/audio_label/transcribers/__init__.py` | chunks 字段 |
| `src/audio_label/transcribers/qwen3.py` | 后处理断句 |
| `src/audio_label/annotator.py` | chunks 字段 |
| `gui/src/lib/api.ts` | chunks 字段 |
| `src/audio_label/exporter.py` | CSV 完整导出 |

### 待实施 — 新建

| 文件 | 说明 |
|------|------|
| `src/audio_label/ollama.py` | Ollama HTTP 客户端 |
| `src/audio_label/transcribers/ollama_asr.py` | Ollama ASR 转写器 |
| `src/audio_label/labeler.py` | LLM 标注服务 |
| `gui/src/lib/AIAnnotationPanel.svelte` | AI 标注面板 |

### 待实施 — 修改

| 文件 | 改动 |
|------|------|
| `src/audio_label/transcribers/__init__.py` | 工厂函数 ollama: 前缀 |
| `src/audio_label/server.py` | `/api/ollama-models`, `/api/label`, `/api/annotate` 改动, `/api/health` 增加 ollama 状态 |
| `src/audio_label/config.py` | 多模态模型关键词 |
| `src/audio_label/annotator.py` | LabelResult + labels 字段 |
| `src/audio_label/exporter.py` | labels 导出 |
| `gui/src/lib/api.ts` | Ollama/Label 类型和函数 |
| `gui/src/lib/ConfigBar.svelte` | 两区域布局 |
| `gui/src/lib/ResultsView.svelte` | 四列布局 + AI 面板集成 |
| `gui/src/App.svelte` | 新状态管理 |

---

## 四、实施顺序建议

| 阶段 | 内容 | 依赖 |
|------|------|------|
| Phase 1 | 后端基础设施：ollama.py + OllamaTranscriber + labeler.py + 数据模型 | 无 |
| Phase 2 | 服务端 API：ollama-models / label / annotate 改动 | Phase 1 |
| Phase 3 | 前端 ConfigBar 分区布局 | Phase 2 |
| Phase 4 | 前端 ResultsView 四列布局 + AIAnnotationPanel | Phase 2 |
| Phase 5 | 导出更新 + 集成测试 | Phase 3 + 4 |

---

## 五、相关文档

- [LLM 后处理方案](./llm-post-processing.md) — 详细的功能模块、Prompt 模板、UI 设计、CSS 样式
- [并行处理方案](./parallel-processing.md) — 流水线并行与动态负载调度
- [生产可行性分析](./production-feasibility.md) — 大批量场景性能预估
