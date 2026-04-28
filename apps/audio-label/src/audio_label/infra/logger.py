"""统一日志初始化：所有模块通过标准 logging 写入同一个目录。

用法：
    from audio_label.infra.logger import get_logger
    logger = get_logger(__name__)
    logger.info("something happened")

调用 setup_logging() 一次（在进程启动点，如 start_server）即可让所有
audio_label.* logger 写入 logs/ 目录下的对应文件。
"""

from __future__ import annotations

import logging
import logging.handlers
from pathlib import Path

_initialized = False


def setup_logging(logs_dir: Path | None = None) -> Path:
    """初始化全局日志配置，返回日志目录路径。幂等，重复调用无副作用。"""
    global _initialized
    if _initialized:
        return _get_logs_dir(logs_dir)

    from audio_label.infra.runtime import logs_dir as _default_logs_dir
    d = logs_dir or _default_logs_dir()
    d.mkdir(parents=True, exist_ok=True)

    fmt = logging.Formatter("%(asctime)s %(levelname)-8s %(name)s: %(message)s")

    # ── 主日志：audio_label.* 全量 ──────────────────────────────
    app_handler = logging.handlers.RotatingFileHandler(
        d / "app.log",
        maxBytes=10 * 1024 * 1024,  # 10 MB
        backupCount=5,
        encoding="utf-8",
    )
    app_handler.setFormatter(fmt)

    # ── 内存日志：专门记录内存快照，方便单独分析 ────────────────
    mem_handler = logging.handlers.RotatingFileHandler(
        d / "memory.log",
        maxBytes=5 * 1024 * 1024,  # 5 MB
        backupCount=3,
        encoding="utf-8",
    )
    mem_handler.setFormatter(fmt)
    mem_handler.addFilter(_MemFilter())

    root_logger = logging.getLogger("audio_label")
    root_logger.setLevel(logging.DEBUG)
    root_logger.addHandler(app_handler)
    root_logger.addHandler(mem_handler)
    # 避免日志向上传播到 uvicorn root logger 造成重复
    root_logger.propagate = False

    _initialized = True
    root_logger.info(f"Logging initialized → {d}")
    return d


def _get_logs_dir(override: Path | None) -> Path:
    from audio_label.infra.runtime import logs_dir as _default
    return override or _default()


def get_logger(name: str) -> logging.Logger:
    """返回 audio_label 命名空间下的 logger，setup_logging() 后自动写入文件。"""
    if not name.startswith("audio_label"):
        name = f"audio_label.{name}"
    return logging.getLogger(name)


class _MemFilter(logging.Filter):
    """只让 [MEM] 标记的日志记录到 memory.log。"""
    def filter(self, record: logging.LogRecord) -> bool:
        return "[MEM]" in record.getMessage()
