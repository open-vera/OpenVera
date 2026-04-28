"""扫描目录/文件列表，发现音频文件并读取基础元数据。"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

from audio_label.config import AUDIO_EXTENSIONS

logger = logging.getLogger(__name__)


@dataclass
class AudioFile:
    path: Path
    duration_sec: float | None = None
    sample_rate: int | None = None
    channels: int | None = None


def _read_metadata(p: Path) -> AudioFile:
    """尝试用 soundfile 读取元数据；失败时仅保留路径。"""
    try:
        import soundfile as sf

        info = sf.info(str(p))
        return AudioFile(
            path=p,
            duration_sec=info.duration,
            sample_rate=info.samplerate,
            channels=info.channels,
        )
    except Exception as e:
        logger.warning(f"读取音频元数据失败 {p.name}: {e}")
        return AudioFile(path=p)


def scan_audio_files(paths: list[str]) -> list[AudioFile]:
    """
    接受文件路径或目录路径列表，递归扫描返回 AudioFile 列表。

    - 目录会递归遍历，按扩展名过滤。
    - 单个文件只要扩展名匹配即纳入。
    - 结果按文件名排序，方便复现。
    """
    found: list[AudioFile] = []
    seen: set[Path] = set()

    for raw in paths:
        p = Path(raw).resolve()
        if p.is_file():
            if p.suffix.lower() in AUDIO_EXTENSIONS and p not in seen:
                seen.add(p)
                found.append(_read_metadata(p))
        elif p.is_dir():
            for child in sorted(p.rglob("*")):
                if child.is_file() and child.suffix.lower() in AUDIO_EXTENSIONS and child not in seen:
                    seen.add(child)
                    found.append(_read_metadata(child))

    return found
