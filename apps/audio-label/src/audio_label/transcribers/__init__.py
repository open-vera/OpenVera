"""ASR 转写器：统一基类、数据类型与工厂函数。"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Segment:
    start: float
    end: float
    text: str
    speaker: str = ""  # 说话人标签（说话人分离后填充，空字符串表示未知）


@dataclass
class TranscribeResult:
    text: str
    language: str | None = None
    segments: list[Segment] = field(default_factory=list)   # 后处理断句（按标点+停顿切分）
    words: list[Segment] = field(default_factory=list)      # 逐字级别（用于歌词高亮）
    chunks: list[Segment] = field(default_factory=list)     # 模型原始分块（保留原貌）


class Transcriber(abc.ABC):
    """ASR 转写器基类。"""

    @abc.abstractmethod
    def transcribe(self, path: Path) -> TranscribeResult:
        ...


BACKENDS: tuple[str, ...] = ("qwen3", "parakeet", "vibevoice", "gemma")


def create_transcriber(backend: str, **kwargs: object) -> Transcriber:
    """根据后端名称创建对应转写器实例。

    Parameters
    ----------
    backend:
        qwen3 | parakeet | vibevoice | gemma | ollama:<model_name>
    **kwargs:
        传递给对应 Transcriber 构造函数的参数（如 model_size）。
    """
    if backend.startswith("ollama:"):
        from audio_label.transcribers.ollama_asr import OllamaTranscriber
        model_name = backend[len("ollama:"):]
        return OllamaTranscriber(model=model_name, **kwargs)
    if backend == "qwen3":
        from audio_label.transcribers.qwen3 import Qwen3Transcriber
        return Qwen3Transcriber(**kwargs)
    if backend == "parakeet":
        from audio_label.transcribers.parakeet import ParakeetTranscriber
        return ParakeetTranscriber(**kwargs)
    if backend == "vibevoice":
        from audio_label.transcribers.vibevoice import VibeVoiceTranscriber
        return VibeVoiceTranscriber(**kwargs)
    if backend == "gemma":
        from audio_label.transcribers.gemma import GemmaTranscriber
        return GemmaTranscriber(**kwargs)
    raise ValueError(f"未知后端 '{backend}'，可选：{', '.join(BACKENDS)} 或 ollama:<模型名>")
