"""NVIDIA Parakeet TDT 后端（MLX，Apple Silicon）。"""

from __future__ import annotations

from pathlib import Path

from audio_label.config import PARAKEET_MODEL_ID
from audio_label.transcribers import Segment, Transcriber, TranscribeResult


class ParakeetTranscriber(Transcriber):
    """通过 parakeet-mlx 调用 Parakeet TDT 模型。"""

    def __init__(self, model_id: str = PARAKEET_MODEL_ID, **_kw: object) -> None:
        try:
            from parakeet_mlx import from_pretrained
        except ImportError as e:
            raise RuntimeError(
                "parakeet-mlx 未安装，请执行：pip install 'veralabel[parakeet]'"
            ) from e

        self._model = from_pretrained(model_id)

    def transcribe(self, path: Path) -> TranscribeResult:
        result = self._model.transcribe(str(path))

        segments: list[Segment] = []
        if hasattr(result, "segments") and result.segments:
            for seg in result.segments:
                segments.append(
                    Segment(
                        start=getattr(seg, "start", 0.0),
                        end=getattr(seg, "end", 0.0),
                        text=getattr(seg, "text", ""),
                    )
                )

        return TranscribeResult(
            text=result.text if hasattr(result, "text") else str(result),
            language="en",
            segments=segments,
        )
