"""进程内存监控：通过统一 logging 记录 RSS 快照。"""

from __future__ import annotations

import gc
import logging
import threading
from typing import Callable

logger = logging.getLogger(__name__)


def get_rss_mb() -> float:
    """返回当前进程 RSS（常驻内存）MB。优先用 psutil，回退到 resource。"""
    try:
        import psutil
        return psutil.Process().memory_info().rss / 1024 / 1024
    except ImportError:
        import resource
        # macOS: ru_maxrss 单位是 bytes
        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024 / 1024


def log_memory(label: str, log_fn: Callable[[str], None] | None = None) -> float:
    """记录当前内存用量，返回 MB。[MEM] 前缀会被路由到 memory.log。"""
    mb = get_rss_mb()
    msg = f"[MEM] {label}: {mb:.0f} MB"
    logger.info(msg)
    if log_fn:
        log_fn(msg)
    return mb


def free_mlx_cache() -> None:
    """清理 MLX Metal 内存缓存（Apple Silicon）。"""
    try:
        import mlx.core as mx
        mx.metal.clear_cache()
    except Exception:
        pass


def release_model_memory() -> None:
    """主动 GC + 释放 MLX 缓存，尽量归还内存给 OS。"""
    gc.collect()
    free_mlx_cache()
    gc.collect()


class MemoryWatcher:
    """后台线程：每隔 interval_sec 秒通过 logging 记录一次内存快照。"""

    def __init__(self, interval_sec: float = 15.0) -> None:
        self._interval = interval_sec
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name="mem-watcher")
        self._thread.start()
        logger.info(f"[MEM] MemoryWatcher started (interval={self._interval}s)")

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            log_memory("periodic")
