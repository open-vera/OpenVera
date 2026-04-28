"""并行处理调度器：ASR 流水线 + 动态 LLM 并发。

架构：
  [文件队列] → [ASR worker ×1] → [llm_queue] → [LLM worker ×N] → [结果]
                (GPU/ANE 独占)   (asyncio.Queue)  (Ollama 并发)

三个阶段：
  Phase 1 — 流水线并行：ASR 和 LLM 重叠执行（本文件核心）
  Phase 2 — LLM 任务级并发：llm_workers 控制同时处理多个文件
  Phase 3 — 动态负载监控：LoadMonitor 根据 CPU/内存/热节流调整 llm_workers
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Callable, Optional

logger = logging.getLogger(__name__)

# ── 哨兵：标识队列结束 ─────────────────────────────────────
_SENTINEL = object()


# ── 数据类 ────────────────────────────────────────────────

@dataclass
class LoadSnapshot:
    cpu_percent: float
    memory_percent: float
    memory_available_gb: float
    thermal_throttled: bool


@dataclass
class ConcurrencyLimits:
    llm_workers: int = 2
    llm_batch_size: int = 2


@dataclass
class LLMConfig:
    model: str
    prompt_name: str
    prompt_content: str


# ── Phase 3：动态负载监控 ─────────────────────────────────

class LoadMonitor:
    """采样 CPU/内存/热节流，动态调整 LLM 并发度。

    使用滑动窗口平均 + 冷却时间，避免瞬时抖动导致频繁调整。
    """

    MEMORY_HIGH = 80       # 内存 > 80%：收缩
    MEMORY_CRITICAL = 90   # 内存 > 90%：最低并发
    CPU_HIGH = 85          # CPU > 85%：暂停扩展
    WINDOW_SIZE = 3        # 滑动窗口采样数
    COOLDOWN_SEC = 10.0    # 两次调整之间最少间隔

    def __init__(self, initial_workers: int = 2) -> None:
        self._limits = ConcurrencyLimits(llm_workers=initial_workers, llm_batch_size=2)
        self._last_adjust = 0.0
        self._cpu_window: list[float] = []
        self._mem_window: list[float] = []

    @property
    def limits(self) -> ConcurrencyLimits:
        return self._limits

    def snapshot(self) -> LoadSnapshot:
        try:
            import psutil
            mem = psutil.virtual_memory()
            return LoadSnapshot(
                cpu_percent=psutil.cpu_percent(interval=0.1),
                memory_percent=mem.percent,
                memory_available_gb=mem.available / (1024 ** 3),
                thermal_throttled=self._check_thermal(),
            )
        except ImportError:
            # psutil 不可用：返回保守默认值，不触发降级
            return LoadSnapshot(
                cpu_percent=0.0,
                memory_percent=50.0,
                memory_available_gb=8.0,
                thermal_throttled=False,
            )

    def _check_thermal(self) -> bool:
        try:
            import psutil
            freq = psutil.cpu_freq()
            if freq and freq.current < freq.max * 0.7:
                return True
        except Exception:
            pass
        return False

    def adjust(self, notify_fn: Callable[[dict], None] | None = None) -> ConcurrencyLimits:
        """根据当前负载调整并发限制。冷却期内直接返回当前值。"""
        now = time.time()
        if now - self._last_adjust < self.COOLDOWN_SEC:
            return self._limits

        snap = self.snapshot()

        # 滑动窗口
        self._cpu_window.append(snap.cpu_percent)
        self._mem_window.append(snap.memory_percent)
        if len(self._cpu_window) > self.WINDOW_SIZE:
            self._cpu_window.pop(0)
            self._mem_window.pop(0)

        avg_cpu = sum(self._cpu_window) / len(self._cpu_window)
        avg_mem = sum(self._mem_window) / len(self._mem_window)

        old = ConcurrencyLimits(self._limits.llm_workers, self._limits.llm_batch_size)

        if snap.thermal_throttled or avg_mem > self.MEMORY_CRITICAL:
            self._limits = ConcurrencyLimits(llm_workers=1, llm_batch_size=1)
            reason = "thermal_throttle" if snap.thermal_throttled else "memory_critical"
        elif avg_mem > self.MEMORY_HIGH or avg_cpu > self.CPU_HIGH:
            self._limits = ConcurrencyLimits(
                llm_workers=max(1, self._limits.llm_workers - 1),
                llm_batch_size=1,
            )
            reason = "high_load"
        elif avg_mem < 60 and avg_cpu < 50:
            self._limits = ConcurrencyLimits(
                llm_workers=min(6, self._limits.llm_workers + 1),
                llm_batch_size=min(3, self._limits.llm_batch_size + 1),
            )
            reason = "low_load"
        else:
            return self._limits  # 负载适中，不调整

        self._last_adjust = now

        if old.llm_workers != self._limits.llm_workers:
            msg = (
                f"[Scheduler] llm_workers {old.llm_workers}→{self._limits.llm_workers}, "
                f"cpu={avg_cpu:.0f}% mem={avg_mem:.0f}% reason={reason}"
            )
            logger.info(msg)
            if notify_fn:
                notify_fn({
                    "event": "load_adjust",
                    "asr_workers": 1,
                    "llm_workers": self._limits.llm_workers,
                    "reason": reason,
                    "cpu_percent": round(avg_cpu, 1),
                    "memory_percent": round(avg_mem, 1),
                })

        return self._limits


# ── Phase 1 + 2：流水线调度器 ─────────────────────────────

class AnnotationScheduler:
    """流水线调度器：单 ASR worker + 动态 LLM worker 池。

    即使 llm_config=None（纯 ASR 模式），仍以 asyncio 方式运行，
    保留 file_done 逐条事件和进度上报，为后续 LLM 集成零成本开关。
    """

    def __init__(
        self,
        transcriber,
        llm_config: LLMConfig | None,
        monitor: LoadMonitor,
        progress_fn: Callable[[dict], None],
        stop_event: threading.Event | None = None,
        pause_event: threading.Event | None = None,
        preprocessor=None,   # AudioPreprocessor | None
        diarize_fn=None,     # Callable[[Path], list[DiarSegment]] | None
    ) -> None:
        self._transcriber = transcriber
        self._llm_config = llm_config
        self._monitor = monitor
        self._progress = progress_fn
        self._stop_event = stop_event
        self._pause_event = pause_event
        self._preprocessor = preprocessor
        self._diarize_fn = diarize_fn

    def run_sync(self, files: list[Path]):
        """在普通线程中运行调度器（内部创建独立 event loop）。"""
        from audio_label.pipeline.annotator import AnnotationRecord
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            return loop.run_until_complete(self._run(files))
        finally:
            loop.close()
            asyncio.set_event_loop(None)

    async def _run(self, files: list[Path]):
        from audio_label.pipeline.annotator import annotate as make_annotation, AnnotationRecord
        from audio_label.pipeline.scanner import _read_metadata

        total = len(files)

        # 初始并发数
        limits = self._monitor.adjust(self._progress)
        n_llm = limits.llm_workers if self._llm_config else 1

        # ASR → LLM 传递队列：最多缓冲 2 个已完成 ASR 的文件，背压控制
        llm_queue: asyncio.Queue = asyncio.Queue(maxsize=n_llm * 2 + 1)

        # 有序收集结果
        results: list[tuple[int, AnnotationRecord]] = []
        results_lock = asyncio.Lock()

        # ── ASR worker（单例，Phase 1）────────────────────────

        async def asr_worker() -> None:
            for i, file_path in enumerate(files):
                # ── 停止检查 ─────────────────────────────────
                if self._stop_event and self._stop_event.is_set():
                    if not stop_emitted[0]:
                        stop_emitted[0] = True
                        self._progress({"event": "stopped", "current": i, "total": total})
                    for _ in range(n_llm):
                        await llm_queue.put(_SENTINEL)
                    return

                # ── 暂停检查 ─────────────────────────────────
                if self._pause_event:
                    emitted = False
                    while not self._pause_event.is_set():
                        if not emitted:
                            self._progress({"event": "paused"})
                            emitted = True
                        await asyncio.sleep(0.2)
                    if emitted:
                        self._progress({"event": "resumed"})
                self._progress({
                    "event": "asr_start",
                    "worker": 0,
                    "file": file_path.name,
                    "index": i + 1,
                    "total": total,
                })
                t0 = time.time()
                try:
                    af = await asyncio.to_thread(_read_metadata, file_path)
                    # 可选：降噪预处理（在独立线程运行，不阻塞 event loop）
                    if self._preprocessor and self._preprocessor.denoise:
                        process_path = await asyncio.to_thread(self._preprocessor.process, file_path)
                    else:
                        process_path = file_path
                    asr_result = await asyncio.to_thread(self._transcriber.transcribe, process_path)
                    elapsed = round(time.time() - t0, 2)
                    self._progress({
                        "event": "asr_done",
                        "worker": 0,
                        "file": file_path.name,
                        "elapsed": elapsed,
                    })
                    record = make_annotation(af, asr_result)
                    # 可选：说话人分离（声学，比 LLM 语义推断更准确）
                    if self._diarize_fn:
                        try:
                            self._progress({"event": "log", "message": f"说话人分离：{file_path.name}"})
                            from audio_label.pipeline.diarization import merge_with_asr
                            diar_segs = await asyncio.to_thread(self._diarize_fn, process_path)
                            # 将说话人标签写入 record.segments
                            seg_dicts = [{"start": s.start, "end": s.end, "text": s.text, "speaker": s.speaker} for s in record.segments]
                            merged = merge_with_asr(diar_segs, seg_dicts)
                            from audio_label.transcribers import Segment
                            record.segments = [Segment(start=d["start"], end=d["end"], text=d["text"], speaker=d.get("speaker", "")) for d in merged]
                        except Exception as e:
                            logger.warning(f"Diarization failed for {file_path.name}: {e}")
                            self._progress({"event": "log", "message": f"⚠ 说话人分离失败（{file_path.name}）：{e}"})
                    await llm_queue.put((i, file_path, record))
                except Exception as e:
                    logger.exception(f"ASR failed: {file_path.name}")
                    self._progress({
                        "event": "file_error",
                        "current": i + 1,
                        "total": total,
                        "file": file_path.name,
                        "error": str(e),
                    })
                    await llm_queue.put((i, file_path, None))  # 占位保序

            # 发送结束哨兵（每个 LLM worker 一个）
            for _ in range(n_llm):
                await llm_queue.put(_SENTINEL)

        # ── LLM worker（Phase 2：N 个并发）───────────────────

        stop_emitted = [False]  # 跨 worker 共享，确保只发一次 stopped 事件

        async def llm_worker(worker_id: int) -> None:
            from audio_label.pipeline.labeler import label_transcript

            while True:
                item = await llm_queue.get()
                if item is _SENTINEL:
                    break

                i, file_path, record = item
                if record is None:
                    continue  # ASR 失败，跳过

                # ── 停止检查 ────────────────────────────────────
                if self._stop_event and self._stop_event.is_set():
                    if not stop_emitted[0]:
                        stop_emitted[0] = True
                        self._progress({"event": "stopped", "current": i + 1, "total": total})
                    return

                # ── 暂停检查 ────────────────────────────────────
                if self._pause_event:
                    emitted_pause = False
                    while not self._pause_event.is_set():
                        if not emitted_pause:
                            self._progress({"event": "paused"})
                            emitted_pause = True
                        await asyncio.sleep(0.2)
                    if emitted_pause:
                        self._progress({"event": "resumed"})

                # Phase 3：每次处理前询问 monitor 是否需要调整（冷却期内无操作）
                self._monitor.adjust(self._progress)

                if self._llm_config:
                    self._progress({
                        "event": "llm_start",
                        "worker": worker_id,
                        "file": file_path.name,
                        "step": self._llm_config.prompt_name,
                    })
                    t0 = time.time()
                    try:
                        label = await asyncio.to_thread(
                            label_transcript,
                            text=record.text,
                            segments=[asdict(s) for s in record.segments],
                            prompt_content=self._llm_config.prompt_content,
                            model=self._llm_config.model,
                            prompt_name=self._llm_config.prompt_name,
                        )
                        record.label = label
                        elapsed = round(time.time() - t0, 2)
                        self._progress({
                            "event": "llm_done",
                            "worker": worker_id,
                            "file": file_path.name,
                            "step": self._llm_config.prompt_name,
                            "elapsed": elapsed,
                        })
                    except Exception as e:
                        logger.exception(f"LLM failed: {file_path.name}")
                        self._progress({
                            "event": "llm_error",
                            "file": file_path.name,
                            "error": str(e),
                        })

                # 通知前端该文件已完成
                self._progress({
                    "event": "file_done",
                    "current": i + 1,
                    "total": total,
                    "file": file_path.name,
                    "result": asdict(record),
                })

                async with results_lock:
                    results.append((i, record))

        # ── 启动并等待 ────────────────────────────────────────
        self._progress({
            "event": "pipeline_start",
            "asr_workers": 1,
            "llm_workers": n_llm,
            "has_llm": self._llm_config is not None,
        })

        asr_task = asyncio.create_task(asr_worker())
        llm_tasks = [asyncio.create_task(llm_worker(i)) for i in range(n_llm)]
        await asyncio.gather(asr_task, *llm_tasks)

        # 按原始顺序排列
        results.sort(key=lambda x: x[0])
        return [r for _, r in results]
