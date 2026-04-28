# LLM 后处理方案

> 利用本地 Ollama 大模型对 ASR 转写结果进行智能后处理，提升标注质量和效率。

## 概述

当前标注流程：`音频 → ASR 转写 → 人工校对 → 导出`

增强后流程：`音频 → ASR 转写 → LLM 后处理 → 人工校对 → 导出`

LLM 后处理作为 ASR 和人工之间的中间层，自动完成纠错、分离、分类等工作，大幅减少人工校对的工作量。

## 模型选择

用户可能安装了不同的 Ollama 模型，需要在 GUI 中帮助用户理解每个模型的特点并做出选择。

### 模型信息卡片

每个可用模型在 UI 中展示为一张卡片，包含以下信息：

```
┌─────────────────────────────────────────────────────────┐
│  🟢 qwen3.5:9b                              9.2B · 5.5GB │
│                                                         │
│  综合能力最强的中文模型，擅长语义理解和文本生成。               │
│  推荐用于纠错、说话人分离等需要深度理解的任务。                 │
│                                                         │
│  擅长  [纠错] [说话人分离] [摘要] [翻译]                    │
│  速度  ████████░░ ~25 tok/s                              │
│  中文  ★★★★★                                             │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  🟢 qwen3:8b                                 8B · 4.9GB │
│                                                         │
│  平衡型中文模型，速度和质量兼顾。                            │
│  适合大批量处理场景，纠错和翻译表现好。                       │
│                                                         │
│  擅长  [纠错] [翻译] [分句]                                │
│  速度  █████████░ ~30 tok/s                              │
│  中文  ★★★★★                                             │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  🟢 gemma3:4b                               4B · 2.5GB  │
│                                                         │
│  轻量快速，Google 出品。结构化输出能力好，                    │
│  适合标签分类、质量评分等简单判断任务。                       │
│                                                         │
│  擅长  [标签分类] [质量评分]                                │
│  速度  ██████████ ~50 tok/s                              │
│  中文  ★★★☆☆                                             │
└─────────────────────────────────────────────────────────┘
```

### 模型元数据结构

```typescript
interface OllamaModelInfo {
  name: string;           // "qwen3.5:9b"
  params: string;         // "9.2B"
  size: string;           // "5.5GB"
  description: string;    // 一句话介绍
  detail: string;         // 详细说明（适合什么任务）
  strengths: string[];    // 擅长的任务标签：["纠错", "说话人分离", ...]
  speed: number;          // 相对速度评分 1-10
  speed_label: string;    // "~25 tok/s"
  chinese: number;        // 中文能力评分 1-5
  recommended_for: string[];  // 推荐用于哪些 step key
}
```

### 已知模型特点库

后端维护一份模型特点映射表，用于匹配 Ollama 检测到的模型：

| 模型匹配 | 描述 | 擅长 | 速度 | 中文 |
|----------|------|------|------|------|
| `qwen3.5:*` | 综合能力最强的中文模型，擅长语义理解和文本生成 | 纠错、说话人分离、摘要、翻译 | 6 | ★★★★★ |
| `qwen3:*` | 平衡型中文模型，速度和质量兼顾 | 纠错、翻译、分句 | 7 | ★★★★★ |
| `gemma3:*` | Google 出品，轻量快速，结构化输出能力好 | 标签分类、质量评分 | 9 | ★★★☆☆ |
| `llama3*` | Meta 出品，英文能力强，中文可用 | 翻译、摘要 | 7 | ★★★☆☆ |
| `phi3*` / `phi4*` | 微软出品，小巧但推理能力强 | 质量评分、标签分类 | 8 | ★★☆☆☆ |
| `deepseek*` | 深度求索，中文理解优秀 | 纠错、说话人分离、翻译 | 6 | ★★★★★ |
| `mistral*` | 欧洲团队，多语言平衡 | 翻译、摘要 | 8 | ★★☆☆☆ |
| *其他* | 通用模型（未收录详细特点） | — | — | — |

对于未收录的模型，显示基本信息（名称、参数量、大小）并标注"未评测"，不阻止用户选择。

## 功能模块

### 1. ASR 纠错

**目标**：基于上下文语义自动修正 ASR 识别错误。

**典型错误类型**：
- 同音字/近音字错误：`"中生什么"` → `"点什么"`
- 词边界错误：`"几盘根"` → `"鸡排跟"`
- 专有名词识别错误：`"开根"` → `"赶紧"`
- 语气词/连词缺失或误判

**Prompt 模板**：

```
你是一个语音识别纠错专家。以下是一段语音识别(ASR)的转写结果，可能存在同音字、近音字或词边界错误。
请根据上下文语义修正错误，只修改明显有误的部分，不要改变原意或润色。

输出格式：只输出修正后的文本，不要解释。

ASR 原文：
{asr_text}
```

**推荐模型**：qwen3.5:9b / qwen3:8b

### 2. 说话人分离

**目标**：根据对话内容语义推断说话人切换，为每句话标注说话人标签。

**适用场景**：
- 多人对话音频（如采访、会议、日常交流）
- ASR 未提供说话人信息时的补充标注

**Prompt 模板**：

```
以下是一段多人对话的语音转写文本。请根据对话内容、称呼、语气等线索，判断说话人切换，为每句话标注说话人。

规则：
- 用 [说话人A]、[说话人B] 等标签标注
- 如果能从内容推断身份（如"爸"），可用具体称呼（如 [儿子]、[父亲]）
- 每次说话人切换时换行

转写文本：
{asr_text}
```

**推荐模型**：qwen3.5:9b（需要较强的语义理解能力）

### 3. 内容摘要与分类

**目标**：自动为音频内容生成摘要和结构化标签。

**标签维度**：
- **场景**：餐厅点餐、会议讨论、课堂教学、日常闲聊……
- **情感基调**：正式、轻松、幽默、严肃、争论……
- **人物关系**：父子、同事、师生、朋友、客服与顾客……
- **话题**：美食、工作、学习、娱乐……
- **语言**：中文、英文、中英混合……

**Prompt 模板**：

```
分析以下语音转写文本，输出结构化标签。

输出 JSON 格式：
{
  "summary": "一句话摘要",
  "scene": "场景",
  "tone": "情感基调",
  "relationship": "人物关系",
  "topics": ["话题1", "话题2"],
  "language": "语言",
  "speaker_count": 说话人数量
}

转写文本：
{asr_text}
```

**推荐模型**：gemma3:4b（轻量快速，结构化输出能力足够）

### 4. 分句优化

**目标**：将粗粒度的 ASR 段落按对话轮次或语义单元重新切分。

**问题**：当前 ASR 的 segments 切割基于 VAD（语音活动检测），一个 segment 可能包含多轮对话，粒度太粗。

**Prompt 模板**：

```
以下是一段语音转写文本，请按对话轮次或语义完整性重新分句。

规则：
- 每个完整的表达作为一句
- 说话人切换处必须分句
- 保留原文，不修改内容
- 每句一行

转写文本：
{asr_text}
```

**推荐模型**：qwen3:8b

### 5. 翻译

**目标**：生成双语标注，便于跨语言使用。

**Prompt 模板**：

```
将以下中文语音转写文本翻译为英文。要求：
- 保持口语化风格
- 保留语气词的语感
- 不要过度书面化

中文原文：
{asr_text}
```

**推荐模型**：qwen3.5:9b / qwen3:8b

### 6. 质量评分

**目标**：对 ASR 结果做可信度评估，标记可能有误的片段，便于人工优先复核。

**Prompt 模板**：

```
以下是语音识别(ASR)的转写结果。请评估每个片段的可信度，找出可能存在错误的部分。

对每个可疑片段，输出：
- 原文片段
- 可疑原因（同音字、语义不通、罕见表达等）
- 置信度评分（1-5，5=很可能正确，1=很可能有误）

转写文本：
{asr_text}
```

**推荐模型**：gemma3:4b（快速扫描）或 qwen3.5:9b（深度分析）

## 实现架构

### Pipeline 设计

```
┌─────────┐     ┌──────────────────────────────────┐     ┌──────────────┐     ┌────────┐
│  ASR    │────▶│  LLM 后处理（单次调用）             │────▶│  人工校对     │────▶│  导出   │
│  转写   │     │  合并 prompt → 一次推理 → 解析分区   │     │  (工作量↓)   │     │        │
└─────────┘     └──────────────────────────────────┘     └──────────────┘     └────────┘
                  ↑ 用户勾选的步骤合并为一条消息，LLM 输出按
                  │ ## 标题分区，前端分别渲染各区块
                  │
                  各步骤 prompt 在运行前拼接为单一 user message
                  纠错 / 分离 / 标签 / 评分 / 翻译 → 一次推理全部返回
```

### 调用方式

所有启用的步骤 prompt 在调用前合并为一条 user message，通过 Ollama `/api/chat` 端点完成单次推理：

```python
# labeler.py — label_transcript()
messages = [
    {"role": "system", "content": _SYSTEM_PROMPT},
    {"role": "user", "content": merged_prompt},   # 已含所有步骤指令
]
result_text = ollama_chat(model, messages)
```

LLM 按 `## 纠错` / `## 说话人分离` 等标题分节输出，前端根据节标题解析并分区渲染，
无需多次调用。

### 配置项

用户可在 GUI 中选择启用哪些步骤；步骤 prompt 在提交前动态拼接，仍是单次 LLM 调用：

```json
{
  "llm_post_processing": {
    "enabled": true,
    "model": "qwen3.5:9b",
    "steps": {
      "error_correction": true,
      "speaker_diarization": true,
      "content_tagging": true,
      "sentence_splitting": false,
      "translation": false,
      "quality_scoring": false
    }
  }
}
```

> **注**：原方案中的 `tag_model`（轻量模型）字段已移除。合并为单次调用后统一使用
> 一个模型，不再区分主模型和轻量模型。

## 数据模型

### AnnotationRecord

```python
@dataclass
class AnnotationRecord:
    file: str
    text: str                        # 原始 ASR 文本
    language: str | None = None
    duration_sec: float | None = None
    sample_rate: int | None = None
    segments: list[Segment] = ...
    words: list[Segment] = ...
    chunks: list[Segment] = ...
    label: LabelResult | None = None  # 单次 LLM 调用的全量结果
```

合并 prompt 后只有一次 LLM 调用，因此 `label` 是单个对象而非列表。
前端通过解析 `label.result`（按 `## 标题` 分节）提取各功能区块的内容。

### 输出 JSON 格式

导出时将 `label.result` 解析后展开到 `llm` 字段：

```json
{
  "file": "example.wav",
  "text": "原始 ASR 文本",
  "llm": {
    "corrected_text": "LLM 纠错后文本",
    "speakers": [
      { "start": 0.0, "end": 1.28, "speaker": "儿子", "text": "你好，吃点啥？" },
      { "start": 1.36, "end": 2.24, "speaker": "父亲", "text": "爸，吃啥？" }
    ],
    "tags": {
      "summary": "父子在餐厅点餐的日常对话",
      "scene": "餐厅点餐",
      "tone": "轻松幽默",
      "relationship": "父子",
      "topics": ["美食", "日常生活"],
      "speaker_count": 2
    },
    "quality": [
      { "text": "中生什么", "reason": "语义不通，疑似同音字错误", "confidence": 2 },
      { "text": "几盘根", "reason": "词边界可能有误", "confidence": 1 }
    ],
    "translation": "Hello, what would you like to eat? ...",
    "confidence": { "overall": 0.85, "labels": { "纠错": 0.9, "说话人": 0.8 } }
  }
}
```

## 性能预估

以 Apple Silicon (M 系列芯片) 为基准，**全部步骤合并为单次推理**：

| 模型 | 推理速度 | 完整 pipeline（纠错+分离+标签+评分）处理 1 分钟音频 |
|------|----------|-----------------------------------------------------|
| qwen3:8b | ~30 tokens/s | ~10-15 秒 |
| qwen3.5:9b | ~25 tokens/s | ~15-20 秒 |

合并调用相比原来多次串行调用（~30-50 秒）可节省约 30-50% 时间。

## 优先级建议

| 优先级 | 功能 | 理由 |
|--------|------|------|
| P0 | ASR 纠错 | 直接提升标注准确率，价值最高 |
| P0 | 质量评分 | 减少人工复核量，ROI 最高 |
| P1 | 说话人分离 | 多人对话场景刚需 |
| P1 | 内容标签 | 批量标注时自动分类很实用 |
| P2 | 分句优化 | 锦上添花，可后续迭代 |
| P2 | 翻译 | 看具体需求场景 |

## 前端展示设计

基于现有 GUI 的 Pico CSS + Svelte 风格，设计 LLM 后处理相关的 UI 组件。

### 1. 后处理配置面板

在 ConfigBar 中新增 LLM 后处理选项区域，紧跟在 ASR 后端选择之后：

```
┌─ 标注配置 ──────────────────────────────────────────────────────┐
│  后端 [Qwen3 ▾]  模型 [0.6B ▾]  格式 [JSON ▾]  提示词 [无 ▾]  │
│                                                                │
│  ── LLM 后处理 ──────────────────────────── [开启 ◉ / 关闭 ○] │
│                                                                │
│  模型 [qwen3.5:9b ▾ ⓘ]                                        │
│                                                                │
│  处理步骤：                                                     │
│  [✓ 纠错] [✓ 质量评分] [✓ 说话人分离] [✓ 内容标签]              │
│  [○ 分句优化] [○ 翻译]                                         │
└────────────────────────────────────────────────────────────────┘
```

**交互细节**：
- 整体开关：一键开启/关闭全部 LLM 后处理，关闭后配置区域折叠
- 模型下拉：只显示 Ollama 中已安装的模型，旁边 ⓘ 图标 hover 显示模型信息卡片（tooltip）
- 单一模型：所有启用步骤的 prompt 合并后由同一模型一次推理完成
- 步骤勾选：chip 样式的 checkbox，选中为蓝色填充，未选为空心；勾选内容影响合并的 prompt，不影响调用次数

### 2. 模型选择器 + 信息弹出

下拉选择器中，每个选项展示关键信息：

```
┌─ 选择模型 ─────────────────────────────┐
│  ● qwen3.5:9b                         │
│    综合最强 · 5.5GB · ~25 tok/s        │
│ ────────────────────────────────────── │
│  ○ qwen3:8b                           │
│    速度均衡 · 4.9GB · ~30 tok/s        │
│ ────────────────────────────────────── │
│  ○ gemma3:4b                          │
│    轻量快速 · 2.5GB · ~50 tok/s        │
└────────────────────────────────────────┘
```

点击 ⓘ 图标弹出详细信息卡片（popover）：

```
┌─ qwen3.5:9b ───────────────────────────┐
│  综合能力最强的中文模型                   │
│  擅长语义理解和文本生成                   │
│                                        │
│  参数  9.2B        大小  5.5GB          │
│  速度  ████████░░  ~25 tok/s           │
│  中文  ★★★★★                           │
│                                        │
│  擅长任务                               │
│  [纠错] [说话人分离] [摘要] [翻译]       │
│                                        │
│  推荐场景                               │
│  需要高准确率的纠错和说话人分离任务         │
└────────────────────────────────────────┘
```

### 3. 结果面板 — LLM 标注展示

在 ResultsView 的转写文本下方，新增 LLM 后处理结果区域。

> **实现说明**：所有分区（标签、纠错、说话人、质量、翻译）均来自**同一次 LLM 调用**的输出，
> 前端按 `## 标题` 分节解析后分别渲染，无需多次请求。

#### 3.1 标签栏（Tags Bar）

在文件信息区域紧贴转写文本上方，横向展示内容标签：

```
┌─ audio_001.wav ─────────────────────────────────────────────┐
│  54.6s · 16kHz · Chinese                                    │
│                                                             │
│  [🏷 餐厅点餐] [😊 轻松幽默] [👥 父子] [🗣 2人] [🍜 美食]     │
│                                                             │
│  📝 父子在餐厅点餐的日常对话，围绕选菜展开轻松讨论              │
│                                                             │
│  ── 转写文本 ────────────────────────────────────────────── │
│  你好，吃点啥？爸，吃啥？……                                   │
└─────────────────────────────────────────────────────────────┘
```

**标签样式**：
- 每个标签为 pill 形状（border-radius: 12px）
- 不同维度用不同底色区分：
  - 场景：蓝色系 `rgba(74, 158, 255, 0.12)` + 蓝色文字
  - 情感：绿色系 `rgba(74, 222, 128, 0.12)` + 绿色文字
  - 关系：紫色系 `rgba(168, 85, 247, 0.12)` + 紫色文字
  - 话题：橙色系 `rgba(251, 146, 60, 0.12)` + 橙色文字
  - 人数：灰色系 `rgba(148, 163, 184, 0.15)` + 灰色文字
- 摘要行：在标签下方，较小字号（13px），浅色显示

#### 3.2 纠错 Diff 展示

当 LLM 纠错后文本和原始 ASR 文本有差异时，用 inline diff 展示修改：

```
┌─ ASR 纠错 ──────────────────────────────────────────────────┐
│  已修正 3 处                                                 │
│                                                             │
│  …爸，那你又 ~~中生~~ →点 什么？                              │
│  …一份 ~~几盘根~~ →鸡排跟 的                                  │
│  …吃完了你还得去上班，~~开根~~ →赶紧 呐                        │
│                                                  [采纳全部]  │
└─────────────────────────────────────────────────────────────┘
```

**交互**：
- 删除部分：红色删除线 + 浅红背景
- 新增部分：绿色文字 + 浅绿背景
- 每处修正可单独点击「采纳」或「忽略」
- 底部「采纳全部」按钮一键应用

#### 3.3 说话人分离展示

替换当前的纯文本 segments 列表，展示带说话人标签的对话视图：

```
┌─ 说话人分离 ──────────────────────────────────────────────┐
│                                                           │
│  [店员]  0:00   你好，吃点啥？                              │
│  [儿子]  0:01   爸，吃啥？                                  │
│  [父亲]  0:02   自己点。                                   │
│  [儿子]  0:03   来个榴莲披萨。                              │
│  [店员]  0:04   好的，榴莲披萨一份。                         │
│  [父亲]  0:05   哎，等会，天气这么热，你吃什么披萨？          │
│                                                           │
└───────────────────────────────────────────────────────────┘
```

**样式**：
- 说话人标签为 pill 徽章，每个说话人分配固定颜色
- 颜色池：蓝、绿、紫、橙、粉（自动分配，最多 5 个说话人）
- 时间戳用 monospace 小字号，灰色
- 点击某行高亮对应音频段并可播放

#### 3.4 质量评分标记

在转写文本中直接标记可疑片段：

```
┌─ 转写文本 ───────────────────────────────────────────────────┐
│                                                              │
│  …爸，那你又 [中生什么]⚠️ ？最喜欢吃的呀……                     │
│  …一份 [几盘根]⚠️ 的，两笼肉酱的……                            │
│                                                              │
│  ⚠️ 2 处可疑      置信度 ● 1/5  ● 2/5                        │
└──────────────────────────────────────────────────────────────┘
```

**交互**：
- 可疑片段用黄色下划波浪线 + ⚠️ 图标标记
- hover 显示 tooltip：原因 + 置信度评分
- 底部汇总条显示总可疑数量和置信度分布
- 点击可疑片段跳转到对应音频位置

#### 3.5 翻译展示

在转写文本下方折叠展示翻译结果：

```
┌─ 翻译 (中 → 英) ─── [展开 ▾] ──────────────────────────────┐
│                                                              │
│  Hello, what would you like to eat?                          │
│  Dad, what are you having?                                   │
│  Order yourself. How about a durian pizza?                   │
│  …                                                          │
└──────────────────────────────────────────────────────────────┘
```

默认折叠，点击展开。如果开启了说话人分离，翻译也按说话人分段展示。

### 4. 后处理进度展示

在批量标注时，进度条下方增加 LLM 后处理状态：

```
┌─ 标注进度 ──────────────────────────────────────────────────┐
│  ████████████████░░░░░░░░░░░░░░  12/30 文件                │
│                                                             │
│  ASR   ⟳ audio_013.wav  (转写中…)                           │
│  LLM   ✓ audio_012.wav  (纠错·说话人·标签·评分)             │
│         ✓ audio_011.wav  (纠错·说话人·标签·评分)             │
│         ⏳ audio_013.wav  等待 ASR 完成…                     │
└─────────────────────────────────────────────────────────────┘
```

**展示逻辑**：
- ASR 行：显示当前正在转写的文件
- LLM 行：每个文件只有一次推理，括号内显示本次调用涵盖的步骤
- 步骤状态：⟳ 处理中（带旋转动画）、✓ 完成（绿色）、⏳ 等待中（灰色）

### 5. 标注状态栏（Status Bar）

标注期间在 top-bar 下方增加一条独立的状态栏，左侧显示系统资源，右侧显示标注日志。标注完成后自动隐藏。

#### 布局

现有 top-bar 不变，状态栏作为紧贴其下的第二行：

```
┌─ top-bar ────────────────────────────────────────────────────────────┐
│  [← 返回]  标注结果                              12/30 完成 ⟳       │
├─ status-bar（仅标注中显示）───────────────────────────────────────────┤
│  CPU 32% ▁▃▅▃▂  MEM 14.6/24GB ██████░░  GPU 45%  │  正在转写 a.wav │
└──────────────────────────────────────────────────────────────────────┘
```

左右分区：

```
┌───────────── 系统资源（固定宽度）──────────────┬───── 标注日志（flex 填充）──────┐
│  CPU 32% ▁▃▅▃▂  MEM 14.6/24GB ██████░░  GPU 45% │  ⟳ 正在转写 audio_013.wav    │
└──────────────────────────────────────────────────┴──────────────────────────────┘
```

左侧三个指标横向排列，每个指标由标签 + 数值 + 微型可视化组成：

```
CPU  32%  ▁▃▅▃▂     MEM  14.6/24 GB  ██████░░     GPU  45%  ▇▇▅
          ^迷你折线               ^容量条                 ^活动条
```

右侧标注日志就是原来 top-bar 里的 `statusMessage`，从 top-bar 移到这里，有更多空间显示完整内容。

#### 各指标详细设计

**CPU**：
- 数值：总 CPU 使用率百分比
- 可视化：最近 10 次采样的迷你折线图（sparkline），宽 40px 高 12px
- 颜色：<60% 绿色，60-85% 橙色，>85% 红色
- 采样间隔：3 秒

**内存（MEM）**：
- 数值：`已用/总量 GB`（如 `14.6/24 GB`）
- 可视化：容量条，8 格宽，填充格数 = 使用百分比
- 颜色：<70% 绿色，70-85% 橙色，>85% 红色
- 当内存 >85% 时数值闪烁提示

**GPU/ANE**：
- 数值：GPU 使用率百分比（macOS 通过 `powermetrics` 或 Metal Performance HUD 获取）
- 可视化：最近 3 次采样的活动条（3 个柱状），高度表示负载
- 颜色：同 CPU 规则
- 如果无法获取 GPU 数据，显示 `GPU --` 灰色

#### 交互

- **hover 展开详情** — 鼠标悬停在资源指示器上，弹出 popover 显示详细信息：

```
┌─ 系统资源 ──────────────────────────┐
│                                     │
│  CPU    32%    Apple M4 Pro 12核     │
│  ▁▂▃▅▃▂▁▃▅▃   最近 30s 趋势        │
│                                     │
│  内存   14.6 / 24.0 GB  (61%)      │
│  ████████████░░░░░░░░              │
│  ASR 模型   1.2 GB                  │
│  LLM 模型   5.8 GB                  │
│  系统+其他   7.6 GB                  │
│                                     │
│  GPU    45%                         │
│  ▇▇▅▃▅▇▅▃▇▅   最近 30s 趋势        │
│                                     │
│  温度   72°C  (正常)                │
│                                     │
│  ── 标注资源占用 ──                   │
│  ASR 推理    ~1.2 GB + GPU          │
│  LLM 推理    ~5.8 GB + GPU          │
│  并发数       LLM ×3                 │
└─────────────────────────────────────┘
```

- **告警状态** — 当资源紧张时，整条状态栏加浅红背景 + 文字提示：

```
┌─ status-bar ⚠ ──────────────────────────────────────────────────────────┐
│  CPU 92% ▅▇█▇█  MEM 21.3/24GB ████████░  GPU 87%  │  ⚠ 资源紧张，已降低并发 │
└─────────────────────────────────────────────────────────────────────────┘
```

#### 后端 API

新增 `/api/system-stats` 端点，前端每 3 秒轮询一次：

```typescript
interface SystemStats {
  cpu_percent: number;         // 0-100
  memory_used_gb: number;      // 已用 GB
  memory_total_gb: number;     // 总量 GB
  memory_percent: number;      // 0-100
  gpu_percent: number | null;  // 0-100 或 null（不可用）
  temperature: number | null;  // CPU 温度 °C 或 null
  thermal_throttled: boolean;  // 是否热节流
  model_memory: {              // 模型内存占用明细
    asr: number | null;        // ASR 模型占用 GB
    llm: number | null;        // LLM 模型占用 GB
  };
  llm_concurrency: number;     // 当前 LLM 并发数
}
```

```python
# server.py
@app.get("/api/system-stats")
async def system_stats():
    import psutil
    mem = psutil.virtual_memory()
    return {
        "cpu_percent": psutil.cpu_percent(interval=0.1),
        "memory_used_gb": round((mem.total - mem.available) / (1024**3), 1),
        "memory_total_gb": round(mem.total / (1024**3), 1),
        "memory_percent": mem.percent,
        "gpu_percent": _get_gpu_percent(),  # macOS 实现
        "temperature": _get_cpu_temperature(),
        "thermal_throttled": _check_thermal(),
        "model_memory": {
            "asr": _estimate_asr_memory(),
            "llm": _estimate_llm_memory(),
        },
        "llm_concurrency": _current_llm_concurrency,
    }
```

#### 仅 ASR/LLM 处理期间显示

状态栏通过 `{#if isAnnotating}` 条件渲染（非 `display:none`），未标注时 DOM 中完全不存在，不占任何高度。标注完成后整条移除（带 slide-up 过渡），top-bar 恢复原来的简洁样式，内容区域自动回收这一行的空间。同时停止 `/api/system-stats` 轮询。

#### 样式

```css
/* 状态栏容器 */
.status-bar {
  display: flex;
  align-items: center;
  padding: 4px 14px;
  border-bottom: 1px solid var(--pico-muted-border-color);
  background: var(--pico-card-sectioning-background-color);
  font-size: 11px;
  font-family: "SF Mono", "Fira Code", monospace;
  flex-shrink: 0;
  gap: 0;
  animation: slide-down 0.2s ease;
}
@keyframes slide-down {
  from { max-height: 0; opacity: 0; padding: 0 14px; }
  to   { max-height: 40px; opacity: 1; }
}
.status-bar.warn {
  background: rgba(248, 113, 113, 0.08);
  border-bottom-color: rgba(248, 113, 113, 0.3);
}

/* 左侧：系统资源区 */
.sys-monitor {
  display: flex;
  align-items: center;
  gap: 14px;
  padding-right: 14px;
  border-right: 1px solid var(--pico-muted-border-color);
  white-space: nowrap;
}

/* 右侧：标注日志区 */
.status-log {
  flex: 1;
  padding-left: 14px;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.7;
}

.stat-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
.stat-label { opacity: 0.5; font-size: 10px; text-transform: uppercase; }
.stat-value { font-weight: 600; }
.stat-value.green { color: #22c55e; }
.stat-value.orange { color: #fb923c; }
.stat-value.red { color: #f87171; }

/* sparkline 迷你折线图 */
.sparkline {
  display: inline-flex;
  align-items: flex-end;
  gap: 1px;
  height: 12px;
}
.sparkline .bar {
  width: 3px;
  border-radius: 1px 1px 0 0;
  background: currentColor;
  transition: height 0.3s ease;
}

/* 内存容量条 */
.mem-bar {
  display: inline-flex;
  gap: 1px;
  vertical-align: middle;
}
.mem-bar .block {
  width: 4px;
  height: 10px;
  border-radius: 1px;
  background: var(--pico-muted-border-color);
}
.mem-bar .block.filled { background: currentColor; }

/* 数值闪烁（内存紧张时） */
@keyframes blink-warn {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
.stat-value.blink { animation: blink-warn 1.5s ease-in-out infinite; }
```

### 6. 设置页 — LLM 模型管理

在 Settings 的「环境管理」tab 中，ASR 模型之后新增 LLM 模型区域：

```
┌─ LLM 模型（Ollama）──────────────────────────────────────────┐
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  qwen3.5:9b                      9.2B · 5.5GB       │    │
│  │  综合能力最强的中文模型              [已安装]  [卸载]  │    │
│  │  [纠错] [说话人分离] [摘要] [翻译]                    │    │
│  │  速度 ████████░░   中文 ★★★★★                       │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  gemma3:4b                        4B · 2.5GB        │    │
│  │  轻量快速，结构化输出好              [已安装]  [卸载]  │    │
│  │  [标签分类] [质量评分]                                │    │
│  │  速度 ██████████   中文 ★★★☆☆                       │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  qwen3:8b                         8B · 4.9GB        │    │
│  │  速度和质量兼顾                    [未安装]  [安装]    │    │
│  │  [纠错] [翻译] [分句]                                 │    │
│  │  速度 █████████░   中文 ★★★★★                       │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  推荐：首次使用建议安装 qwen3.5:9b（综合最佳）                  │
│       + gemma3:4b（轻量补充）                                 │
│                                                              │
│                                          [拉取其他模型…]      │
└──────────────────────────────────────────────────────────────┘
```

### 7. CSS 样式规范

与现有 Pico CSS 风格保持一致：

```css
/* 标签 pill */
.tag-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px;
  border-radius: 12px;
  font-size: 12px;
  white-space: nowrap;
}
.tag-scene    { background: rgba(74, 158, 255, 0.12); color: #4a9eff; }
.tag-tone     { background: rgba(74, 222, 128, 0.12); color: #22c55e; }
.tag-relation { background: rgba(168, 85, 247, 0.12); color: #a855f7; }
.tag-topic    { background: rgba(251, 146, 60, 0.12); color: #fb923c; }
.tag-meta     { background: rgba(148, 163, 184, 0.15); color: #94a3b8; }

/* 说话人标签 */
.speaker-badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
}
.speaker-0 { background: rgba(74, 158, 255, 0.15); color: #4a9eff; }
.speaker-1 { background: rgba(74, 222, 128, 0.15); color: #22c55e; }
.speaker-2 { background: rgba(168, 85, 247, 0.15); color: #a855f7; }
.speaker-3 { background: rgba(251, 146, 60, 0.15); color: #fb923c; }
.speaker-4 { background: rgba(244, 114, 182, 0.15); color: #f472b6; }

/* 纠错 diff */
.diff-del { text-decoration: line-through; background: rgba(248, 113, 113, 0.15); color: #f87171; }
.diff-ins { background: rgba(74, 222, 128, 0.15); color: #22c55e; }

/* 质量警告 */
.quality-warn {
  text-decoration: underline wavy #fbbf24;
  cursor: pointer;
}
.quality-warn:hover {
  background: rgba(251, 191, 36, 0.1);
}

/* 速度条 */
.speed-bar {
  display: inline-flex;
  gap: 1px;
  vertical-align: middle;
}
.speed-bar .block {
  width: 6px;
  height: 12px;
  border-radius: 1px;
  background: var(--pico-muted-border-color);
}
.speed-bar .block.filled {
  background: var(--pico-primary);
}

/* 星级评分 */
.stars { color: #fbbf24; letter-spacing: 1px; font-size: 12px; }
.stars .empty { opacity: 0.25; }
```
