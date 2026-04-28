# 并行处理与动态负载调度

> 通过流水线并行和动态并发控制，充分利用本地硬件资源，提升批量标注吞吐量。

## 问题

当前标注流程是严格串行的：

```
[ASR file1] → [ASR file2] → [ASR file3] → ... → [导出]
```

对于 100 个文件的批量任务，如果每个文件 ASR 需要 10 秒、LLM 后处理需要 15 秒，总耗时 = 100 × 25s = **42 分钟**。

## 目标

通过并行化将吞吐量提升 2-4 倍，同时不超出本地硬件能力。

## 并行化策略

### 策略一：流水线并行（Pipeline Parallelism）

ASR 和 LLM 后处理是两个独立阶段，可以重叠执行：

```
串行：
  [ASR f1][LLM f1][ASR f2][LLM f2][ASR f3][LLM f3]
  ├──────────────── 总时间 ──────────────────────┤

流水线：
  [ASR f1][ASR f2][ASR f3]
         [LLM f1][LLM f2][LLM f3]
  ├────────── 总时间（~节省 40%）──────────┤
```

**原理**：ASR 完成一个文件后立即开始下一个，同时 LLM 开始处理上一个文件的结果。两者使用不同的计算资源（MLX vs Ollama），可以重叠。

### 为什么 ASR 不能并发

ASR 阶段的瓶颈是 GPU/ANE 计算单元，是硬件独占资源：

- **MLX 后端**（qwen3, parakeet）：底层 Metal GPU 命令队列是单队列串行的，即使创建多个 Session 实例，推理也是排队执行，多实例只会白白多占显存
- **Transformers 后端**（vibevoice, gemma）：`device_map="auto"` 将模型放到 GPU/MPS，同一张卡上多实例同样是串行抢占

因此 ASR 始终保持单 worker，并行收益全部来自 ASR 与 LLM 的流水线重叠以及 LLM 阶段的并发。

### 策略二：LLM 任务级并行（Task Parallelism）

LLM 后处理阶段，Ollama 天然支持并发请求：

```
LLM 并发：
  [LLM f1]
  [LLM f2]
  [LLM f3]  ← 同时处理多个文件
```

**Ollama 并发能力**：
- 同一模型的多个请求共享已加载权重，内存开销可控
- 通过 `OLLAMA_NUM_PARALLEL` 环境变量配置（默认 4）

> **注**：原方案中的「步骤级并行」（同一文件的纠错/标签/评分并行）已随 prompt
> 合并而取消。现在所有启用步骤合并为一次 LLM 调用，不存在步骤间的并行关系。

## 架构设计

### 整体架构

```
                    ┌─────────────────────────────────┐
                    │        Load Monitor              │
                    │  (CPU / Memory / Thermal)        │
                    └──────────┬──────────────────────┘
                               │ 动态调节 LLM 并发
                               ▼
┌──────────┐    ┌──────────────────────────┐    ┌──────────────┐
│  文件队列  │──▶│     Scheduler             │──▶│   结果收集    │
│  (input)  │    │                          │    │   (output)   │
└──────────┘    │  ┌──────┐   ┌──────────┐ │    └──────────────┘
                │  │ ASR  │──▶│ LLM Pool │ │
                │  │(单例) │   │ (并发)    │ │
                │  └──────┘   └──────────┘ │
                └──────────────────────────┘
```

### 核心组件

**`LoadSnapshot` / `ConcurrencyLimits`**：负载快照和并发限制的数据类。

```python
@dataclass
class LoadSnapshot:
    cpu_percent: float
    memory_percent: float
    memory_available_gb: float
    thermal_throttled: bool

@dataclass
class ConcurrencyLimits:
    llm_workers: int = 2     # 同时处理多少个文件的 LLM 阶段
    llm_batch_size: int = 2  # 保留字段，当前单次调用不再使用
```

**`LLMConfig`**：描述本次 LLM 调用的配置，由调用方构造后传入 Scheduler。

```python
@dataclass
class LLMConfig:
    model: str           # Ollama 模型名
    prompt_name: str     # 用于进度事件展示
    prompt_content: str  # 已合并的全量 prompt 内容
```

### LoadMonitor（Phase 3）

采样 CPU / 内存 / 热节流，使用**滑动窗口均值 + 冷却时间**动态调节 `llm_workers`：

```python
class LoadMonitor:
    MEMORY_HIGH = 80       # 内存 > 80%：收缩
    MEMORY_CRITICAL = 90   # 内存 > 90%：最低并发
    CPU_HIGH = 85          # CPU > 85%：暂停扩展
    WINDOW_SIZE = 3        # 滑动窗口采样数
    COOLDOWN_SEC = 10.0    # 两次调整之间最少间隔
```

`adjust(notify_fn)` 在冷却期内直接返回当前值；调整发生时通过 `notify_fn` 向前端
推送 `load_adjust` 事件。`psutil` 不可用时返回保守默认值，不触发降级。

### AnnotationScheduler（Phase 1 + 2）

```
[文件列表]
    │
    ▼ asr_worker（单协程，asyncio.to_thread 跑同步转写）
    │
    ├─ llm_queue（有界队列，maxsize = n_llm×2+1，提供背压）
    │
    ▼ llm_worker ×N（并发协程，asyncio.to_thread 跑同步 label_transcript）
    │
    ▼ results（按原始顺序排列后返回）
```

关键细节：
- **哨兵透传**：ASR worker 结束时向队列放 N 个 `_SENTINEL`；LLM worker 收到后再放回一个再退出，保证所有 worker 都能收到信号
- **背压控制**：`llm_queue` 有界（`maxsize = n_llm×2+1`），ASR 产出过快时自动阻塞，避免内存堆积
- **保序**：每条结果携带原始下标 `i`，最终 `results.sort(key=lambda x: x[0])` 还原顺序
- **ASR 失败占位**：失败时向队列放 `(i, file_path, None)`，LLM worker 跳过但保留位置，不破坏保序逻辑
- **停止/暂停**：`stop_event` 和 `pause_event` 均在 ASR worker 的文件循环头部检查

`run_sync()` 创建独立 event loop 在普通线程中运行，调用方无需关心 asyncio。

## 动态负载调度规则

### 状态机

```
                    ┌────────────┐
          低负载时   │            │  高负载时
       ┌──扩展──────▶  NORMAL   ◀──收缩──┐
       │            │ LLM: 2    │         │
       │            └─────┬─────┘         │
       │                  │               │
  ┌────┴─────┐    内存>80% │      ┌───────┴──────┐
  │ SCALING  │    CPU>85%  │      │  THROTTLED   │
  │ LLM: 4-6 │◀───────────┘      │  LLM: 1      │
  └──────────┘                    └──────────────┘
       │                                 ▲
       │     热节流 / 内存>90%            │
       └─────────────────────────────────┘
```

> ASR 始终单 worker，不参与动态调度。

### 调度参数参考

以 Apple Silicon 为基准：

| 机器配置 | LLM 并发 | 说明 |
|----------|----------|------|
| M1/M2 8GB | 1-2 | 内存受限，保守策略 |
| M1/M2 16GB | 2-4 | 流水线并行效果明显 |
| M1 Pro/Max 32GB | 4-6 | 充分并行 |
| M1 Ultra 64GB+ | 6+ | 全速并行 |

### 监控指标采样

```
滑动窗口：最近 3 次采样的平均值（WINDOW_SIZE = 3）
冷却时间：两次调整间隔至少 10 秒（COOLDOWN_SEC = 10.0）
```

## 进度事件

所有事件通过 `progress_fn(dict)` 同步回调推送，前端据此更新 UI：

```json
{"event": "pipeline_start", "asr_workers": 1, "llm_workers": 3, "has_llm": true}
{"event": "asr_start",  "worker": 0, "file": "audio1.wav", "index": 1, "total": 100}
{"event": "asr_done",   "worker": 0, "file": "audio1.wav", "elapsed": 8.2}
{"event": "llm_start",  "worker": 1, "file": "audio1.wav", "step": "merged"}
{"event": "llm_done",   "worker": 1, "file": "audio1.wav", "step": "merged", "elapsed": 14.3}
{"event": "file_done",  "current": 1, "total": 100, "file": "audio1.wav", "result": {...}}
{"event": "load_adjust", "asr_workers": 1, "llm_workers": 2, "reason": "high_load", "cpu_percent": 87.0, "memory_percent": 82.0}
{"event": "file_error", "current": 2, "total": 100, "file": "audio2.wav", "error": "..."}
{"event": "paused"}
{"event": "resumed"}
{"event": "stopped", "current": 5, "total": 100}
```

> `llm_start` / `llm_done` 的 `step` 字段现在是合并 prompt 的名称（如 `"merged"`），
> 不再是单个步骤名，因为所有启用步骤已合并为一次调用。

## 性能预估

处理 100 个文件（平均 1 分钟/文件）：

| 模式 | ASR 总耗时 | LLM 总耗时 | 端到端 | 加速比 |
|------|-----------|-----------|--------|--------|
| 纯串行 | 1000s | 2500s | ~58 min | 1x |
| Pipeline 并行（ASR+LLM 重叠） | 1000s | 2500s | ~42 min | 1.4x |
| Pipeline + LLM ×3 并发 | 1000s | 850s | ~20 min | 2.9x |
| Pipeline + LLM ×6 并发 | 1000s | 420s | ~17 min | 3.4x |

## 实现阶段

| 阶段 | 内容 | 状态 |
|------|------|------|
| **Phase 1** | Pipeline 并行（单 ASR + 单 LLM，流水线重叠） | ✅ 已实现 |
| **Phase 2** | LLM 任务级并发（多文件同时 LLM） | ✅ 已实现 |
| **Phase 3** | 动态负载监控 + 自适应调度 | ✅ 已实现 |


> 通过流水线并行和动态并发控制，充分利用本地硬件资源，提升批量标注吞吐量。

## 问题

当前标注流程是严格串行的：

```
[ASR file1] → [ASR file2] → [ASR file3] → ... → [导出]
```

对于 100 个文件的批量任务，如果每个文件 ASR 需要 10 秒、LLM 后处理需要 15 秒，总耗时 = 100 × 25s = **42 分钟**。

## 目标

通过并行化将吞吐量提升 2-4 倍，同时不超出本地硬件能力。

## 并行化策略

### 策略一：流水线并行（Pipeline Parallelism）

ASR 和 LLM 后处理是两个独立阶段，可以重叠执行：

```
串行：
  [ASR f1][LLM f1][ASR f2][LLM f2][ASR f3][LLM f3]
  ├──────────────── 总时间 ──────────────────────┤

流水线：
  [ASR f1][ASR f2][ASR f3]
         [LLM f1][LLM f2][LLM f3]
  ├────────── 总时间（~节省 40%）──────────┤
```

**原理**：ASR 完成一个文件后立即开始下一个，同时 LLM 开始处理上一个文件的结果。两者使用不同的计算资源（MLX vs Ollama），可以重叠。

### 为什么 ASR 不能并发

ASR 阶段的瓶颈是 GPU/ANE 计算单元，是硬件独占资源：

- **MLX 后端**（qwen3, parakeet）：底层 Metal GPU 命令队列是单队列串行的，即使创建多个 Session 实例，推理也是排队执行，多实例只会白白多占显存
- **Transformers 后端**（vibevoice, gemma）：`device_map="auto"` 将模型放到 GPU/MPS，同一张卡上多实例同样是串行抢占

因此 ASR 始终保持单 worker，并行收益全部来自 ASR 与 LLM 的流水线重叠以及 LLM 阶段的并发。

### 策略二：LLM 任务级并行（Task Parallelism）

LLM 后处理阶段，Ollama 天然支持并发请求：

```
LLM 并发：
  [LLM f1]
  [LLM f2]
  [LLM f3]  ← 同时处理多个文件
```

**Ollama 并发能力**：
- 同一模型的多个请求共享已加载权重，内存开销可控
- 通过 `OLLAMA_NUM_PARALLEL` 环境变量配置（默认 4）
- 不同后处理步骤（纠错、分类）可分发到不同模型并行执行

### 策略三：步骤级并行（Step Parallelism）

同一个文件的不同 LLM 后处理步骤可以并行：

```
文件 f1 的 LLM 后处理：
  串行：[纠错] → [说话人分离] → [内容标签] → [质量评分]
  并行：[纠错        ]
        [内容标签     ]  ← 标签和评分不依赖纠错结果
        [质量评分     ]
        ──等纠错完成──→ [说话人分离]  ← 分离依赖纠错后文本
```

**依赖关系**：
- 独立步骤：内容标签、质量评分、翻译（可直接基于 ASR 原文）
- 依赖纠错：说话人分离、分句优化（需要纠错后的文本）

## 架构设计

### 整体架构

```
                    ┌─────────────────────────────────┐
                    │        Load Monitor              │
                    │  (CPU / Memory / Thermal)        │
                    └──────────┬──────────────────────┘
                               │ 动态调节 LLM 并发
                               ▼
┌──────────┐    ┌──────────────────────────┐    ┌──────────────┐
│  文件队列  │──▶│     Scheduler             │──▶│   结果收集    │
│  (input)  │    │                          │    │   (output)   │
└──────────┘    │  ┌──────┐   ┌──────────┐ │    └──────────────┘
                │  │ ASR  │──▶│ LLM Pool │ │
                │  │(单例) │   │ (并发)    │ │
                │  └──────┘   └──────────┘ │
                └──────────────────────────┘
```

### 核心组件

```python
import asyncio
import psutil
from dataclasses import dataclass


@dataclass
class LoadSnapshot:
    """系统负载快照"""
    cpu_percent: float        # CPU 使用率 (0-100)
    memory_percent: float     # 内存使用率 (0-100)
    memory_available_gb: float  # 可用内存 (GB)
    thermal_throttled: bool   # 是否热节流


@dataclass
class ConcurrencyLimits:
    """当前并发限制"""
    llm_workers: int    # LLM 并发数（通常 2-6）
    llm_batch_size: int # LLM 单文件步骤并发数


class LoadMonitor:
    """动态负载监控，决定并发度"""

    # ── 阈值 ──
    MEMORY_HIGH = 80     # 内存 > 80%：降低并发
    MEMORY_CRITICAL = 90 # 内存 > 90%：最低并发
    CPU_HIGH = 85        # CPU > 85%：暂停扩展
    COOLDOWN_SEC = 5     # 调整冷却时间

    def __init__(self):
        self._limits = ConcurrencyLimits(llm_workers=2, llm_batch_size=2)
        self._last_adjust = 0

    def snapshot(self) -> LoadSnapshot:
        mem = psutil.virtual_memory()
        return LoadSnapshot(
            cpu_percent=psutil.cpu_percent(interval=0.1),
            memory_percent=mem.percent,
            memory_available_gb=mem.available / (1024 ** 3),
            thermal_throttled=self._check_thermal(),
        )

    def _check_thermal(self) -> bool:
        """macOS 热节流检测（通过 powermetrics 或 smc）"""
        # 简化实现：检查 CPU 频率是否低于基准
        try:
            freq = psutil.cpu_freq()
            if freq and freq.current < freq.max * 0.7:
                return True
        except Exception:
            pass
        return False

    def adjust(self) -> ConcurrencyLimits:
        """根据当前负载动态调整并发限制"""
        snap = self.snapshot()

        if snap.thermal_throttled or snap.memory_percent > self.MEMORY_CRITICAL:
            # 紧急降级：最低并发
            self._limits = ConcurrencyLimits(llm_workers=1, llm_batch_size=1)

        elif snap.memory_percent > self.MEMORY_HIGH or snap.cpu_percent > self.CPU_HIGH:
            # 高负载：收缩
            self._limits = ConcurrencyLimits(
                llm_workers=max(1, self._limits.llm_workers - 1),
                llm_batch_size=1,
            )

        elif snap.memory_percent < 60 and snap.cpu_percent < 50:
            # 低负载：尝试扩展
            self._limits = ConcurrencyLimits(
                llm_workers=min(6, self._limits.llm_workers + 1),
                llm_batch_size=min(3, self._limits.llm_batch_size + 1),
            )

        return self._limits
```

### Scheduler（调度器）

```python
class AnnotationScheduler:
    """流水线调度器：管理 ASR → LLM 的并行流水线"""

    def __init__(self, transcriber, llm_processor, monitor: LoadMonitor):
        self.transcriber = transcriber
        self.llm_processor = llm_processor
        self.monitor = monitor
        self._asr_queue: asyncio.Queue[Path] = asyncio.Queue()
        self._llm_queue: asyncio.Queue[tuple[Path, TranscribeResult]] = asyncio.Queue()
        self._results: list[AnnotationRecord] = []

    async def run(self, files: list[Path], progress_callback=None) -> list[AnnotationRecord]:
        """执行全部文件的标注"""

        # 填充输入队列
        for f in files:
            await self._asr_queue.put(f)

        # 启动 workers：ASR 固定单 worker，LLM 动态并发
        limits = self.monitor.adjust()
        asr_task = asyncio.create_task(self._asr_worker(progress_callback))
        llm_tasks = [
            asyncio.create_task(self._llm_worker(i, progress_callback))
            for i in range(limits.llm_workers)
        ]

        # 等待所有 ASR 完成
        await self._asr_queue.join()

        # 发送结束信号给 LLM workers
        for _ in llm_tasks:
            await self._llm_queue.put(None)
        await asyncio.gather(*llm_tasks)

        asr_task.cancel()

        return self._results

    async def _asr_worker(self, callback):
        """ASR 工作线程（单例）：取文件 → 转写 → 送入 LLM 队列"""
        while True:
            try:
                file_path = self._asr_queue.get_nowait()
            except asyncio.QueueEmpty:
                break

            result = await asyncio.to_thread(self.transcriber.transcribe, file_path)
            await self._llm_queue.put((file_path, result))
            self._asr_queue.task_done()

            if callback:
                callback("asr_done", file_path, result)

    async def _llm_worker(self, worker_id: int, callback):
        """LLM 工作线程：取 ASR 结果 → 后处理 → 收集结果"""
        while True:
            item = await self._llm_queue.get()
            if item is None:
                break

            file_path, asr_result = item

            # 步骤级并行：独立步骤同时执行
            limits = self.monitor.adjust()
            llm_result = await self.llm_processor.process(
                asr_result.text,
                max_concurrent_steps=limits.llm_batch_size,
            )

            record = make_annotation_with_llm(file_path, asr_result, llm_result)
            self._results.append(record)

            if callback:
                callback("llm_done", file_path, record)
```

### LLM Processor（步骤级并行）

```python
class LLMProcessor:
    """LLM 后处理器：支持步骤级并行"""

    def __init__(self, config: dict):
        self.config = config
        self.ollama_url = "http://localhost:11434/api/generate"

    async def process(self, text: str, max_concurrent_steps: int = 2) -> dict:
        """并行执行多个后处理步骤"""

        # 分为独立步骤和依赖步骤
        independent = []  # 不依赖其他步骤结果
        dependent = []    # 依赖纠错结果

        steps = self.config.get("steps", {})
        if steps.get("content_tagging"):
            independent.append(("tags", self._tag, text))
        if steps.get("quality_scoring"):
            independent.append(("quality", self._score_quality, text))
        if steps.get("translation"):
            independent.append(("translation", self._translate, text))
        if steps.get("error_correction"):
            independent.append(("corrected_text", self._correct, text))

        # 第一阶段：并行执行独立步骤
        sem = asyncio.Semaphore(max_concurrent_steps)
        results = {}

        async def _run(name, func, input_text):
            async with sem:
                results[name] = await func(input_text)

        await asyncio.gather(*[
            _run(name, func, inp) for name, func, inp in independent
        ])

        # 第二阶段：依赖纠错结果的步骤
        corrected = results.get("corrected_text", text)
        if steps.get("speaker_diarization"):
            dependent.append(("speakers", self._diarize, corrected))
        if steps.get("sentence_splitting"):
            dependent.append(("sentences", self._split_sentences, corrected))

        await asyncio.gather(*[
            _run(name, func, inp) for name, func, inp in dependent
        ])

        return results

    async def _call_ollama(self, prompt: str, model: str) -> str:
        """调用 Ollama API"""
        import httpx
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                self.ollama_url,
                json={"model": model, "prompt": prompt, "stream": False,
                      "options": {"temperature": 0.1}},
                timeout=120,
            )
            return resp.json()["response"]

    async def _correct(self, text: str) -> str:
        return await self._call_ollama(CORRECT_PROMPT.format(asr_text=text), self.config["model"])

    async def _diarize(self, text: str) -> list:
        raw = await self._call_ollama(DIARIZE_PROMPT.format(asr_text=text), self.config["model"])
        return parse_speakers(raw)

    async def _tag(self, text: str) -> dict:
        raw = await self._call_ollama(TAG_PROMPT.format(asr_text=text), self.config.get("tag_model", "gemma3:4b"))
        return json.loads(raw)

    async def _score_quality(self, text: str) -> list:
        raw = await self._call_ollama(QUALITY_PROMPT.format(asr_text=text), self.config.get("tag_model", "gemma3:4b"))
        return json.loads(raw)

    async def _translate(self, text: str) -> str:
        return await self._call_ollama(TRANSLATE_PROMPT.format(asr_text=text), self.config["model"])

    async def _split_sentences(self, text: str) -> list:
        raw = await self._call_ollama(SPLIT_PROMPT.format(asr_text=text), self.config["model"])
        return raw.strip().split("\n")
```

## 动态负载调度规则

### 状态机

```
                    ┌────────────┐
          低负载时   │            │  高负载时
       ┌──扩展──────▶  NORMAL   ◀──收缩──┐
       │            │ LLM: 2    │         │
       │            └─────┬─────┘         │
       │                  │               │
  ┌────┴─────┐    内存>80% │      ┌───────┴──────┐
  │ SCALING  │    CPU>85%  │      │  THROTTLED   │
  │ LLM: 4-6 │◀───────────┘      │  LLM: 1      │
  └──────────┘                    └──────────────┘
       │                                 ▲
       │     热节流 / 内存>90%            │
       └─────────────────────────────────┘
```

> ASR 始终单 worker，不参与动态调度。

### 调度参数参考

以 Apple Silicon 为基准：

| 机器配置 | LLM 并发 | 说明 |
|----------|----------|------|
| M1/M2 8GB | 1-2 | 内存受限，保守策略 |
| M1/M2 16GB | 2-4 | 流水线并行效果明显 |
| M1 Pro/Max 32GB | 4-6 | 充分并行 |
| M1 Ultra 64GB+ | 6+ | 全速并行 |

### 监控指标采样

```python
# 每 N 秒采样一次，避免频繁调整
SAMPLE_INTERVAL = 3  # 秒

# 使用滑动窗口平均，避免瞬时波动触发调整
WINDOW_SIZE = 3      # 最近 3 次采样的平均值

# 调整冷却时间，避免频繁抖动
COOLDOWN = 10        # 秒，上次调整后至少等 10 秒
```

## ASR 阶段的优化

ASR 无法真正并发（GPU/ANE 硬件独占），但可以通过 I/O 预读减少等待：

```
[ASR: GPU 推理 file1] [ASR: GPU 推理 file2]
     [I/O: 读取 file2]      [I/O: 读取 file3]  ← I/O 和计算重叠
```

在 GPU 推理当前文件时，提前将下一个音频文件读入内存，消除 I/O 瓶颈。

## 进度反馈

并行处理时，进度事件需要支持多 worker 并发上报：

```json
{"event": "asr_start",  "worker": 0, "file": "audio1.wav", "index": 1, "total": 100}
{"event": "asr_done",   "worker": 0, "file": "audio1.wav", "elapsed": 8.2}
{"event": "llm_start",  "worker": 1, "file": "audio1.wav", "step": "error_correction"}
{"event": "asr_start",  "worker": 0, "file": "audio2.wav", "index": 2, "total": 100}
{"event": "llm_done",   "worker": 1, "file": "audio1.wav", "step": "error_correction"}
{"event": "llm_start",  "worker": 1, "file": "audio1.wav", "step": "speaker_diarization"}
{"event": "llm_start",  "worker": 2, "file": "audio1.wav", "step": "content_tagging"}
{"event": "load_adjust", "asr_workers": 1, "llm_workers": 3, "reason": "memory_ok"}
```

## 性能预估

处理 100 个文件（平均 1 分钟/文件）：

| 模式 | ASR 总耗时 | LLM 总耗时 | 端到端 | 加速比 |
|------|-----------|-----------|--------|--------|
| 纯串行 | 1000s | 2500s | ~58 min | 1x |
| Pipeline 并行（ASR+LLM 重叠） | 1000s | 2500s | ~42 min | 1.4x |
| Pipeline + LLM ×3 并发 | 1000s | 850s | ~20 min | 2.9x |
| Pipeline + LLM ×6 并发 | 1000s | 420s | ~17 min | 3.4x |

## 实现优先级

| 阶段 | 内容 | 复杂度 |
|------|------|--------|
| **Phase 1** | Pipeline 并行（ASR → LLM 流水线，单 ASR + 单 LLM） | 低 |
| **Phase 2** | LLM 步骤级/任务级并发 | 中 |
| **Phase 3** | 动态负载监控 + 自适应 LLM 并发调度 | 中 |

Phase 1 改动最小收益最大，建议优先实现。
