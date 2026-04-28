"""标注逻辑：将 ASR 转写结果与音频元数据组合为标注记录。"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from audio_label.pipeline.scanner import AudioFile
from audio_label.transcribers import Segment, TranscribeResult
from audio_label.pipeline.labeler import LabelResult


@dataclass
class AnnotationRecord:
    file: str
    text: str
    language: str | None = None
    duration_sec: float | None = None
    sample_rate: int | None = None
    segments: list[Segment] = field(default_factory=list)
    words: list[Segment] = field(default_factory=list)
    chunks: list[Segment] = field(default_factory=list)
    label: LabelResult | None = None


def annotate(audio: AudioFile, result: TranscribeResult) -> AnnotationRecord:
    """将单条音频的扫描信息与 ASR 结果合并为标注记录。"""
    return AnnotationRecord(
        file=str(audio.path),
        text=result.text,
        language=result.language,
        duration_sec=audio.duration_sec,
        sample_rate=audio.sample_rate,
        segments=result.segments,
        words=result.words,
        chunks=result.chunks,
    )
