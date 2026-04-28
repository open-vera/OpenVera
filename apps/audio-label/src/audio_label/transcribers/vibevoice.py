"""Microsoft VibeVoice-ASR 后端（Transformers，需 GPU 或大内存）。"""

from __future__ import annotations

import re
from pathlib import Path

from audio_label.config import VIBEVOICE_MODEL_ID
from audio_label.transcribers import Segment, Transcriber, TranscribeResult


class VibeVoiceTranscriber(Transcriber):
    """通过 HuggingFace Transformers 调用 VibeVoice-ASR。

    特点：单次最长 60 分钟、内置说话人分离与时间戳。
    """

    def __init__(self, model_id: str = VIBEVOICE_MODEL_ID, **_kw: object) -> None:
        try:
            from transformers import AutoProcessor, VibeVoiceAsrForConditionalGeneration
        except ImportError as e:
            raise RuntimeError(
                "transformers 未安装或版本过低，请执行：pip install 'veralabel[vibevoice]'"
            ) from e

        self._processor = AutoProcessor.from_pretrained(model_id)
        self._model = VibeVoiceAsrForConditionalGeneration.from_pretrained(
            model_id, device_map="auto"
        )

    def transcribe(self, path: Path) -> TranscribeResult:
        import torch
        import soundfile as sf

        audio, sr = sf.read(str(path))
        if sr != 24000:
            import numpy as np
            # 简单重采样：VibeVoice 需要 24kHz
            duration = len(audio) / sr
            target_len = int(duration * 24000)
            audio = np.interp(
                np.linspace(0, len(audio) - 1, target_len),
                np.arange(len(audio)),
                audio,
            )
            sr = 24000

        inputs = self._processor(
            audio,
            sampling_rate=sr,
            return_tensors="pt",
        ).to(self._model.device)

        with torch.no_grad():
            outputs = self._model.generate(**inputs, max_new_tokens=8192)

        raw_text = self._processor.batch_decode(outputs, skip_special_tokens=True)[0]

        # 尝试解析说话人 + 时间戳格式
        segments = self._parse_segments(raw_text)
        plain_text = " ".join(s.text for s in segments) if segments else raw_text

        return TranscribeResult(
            text=plain_text,
            language=None,
            segments=segments,
        )

    @staticmethod
    def _parse_segments(raw: str) -> list[Segment]:
        """尝试从 VibeVoice 输出中解析 [speaker] <start-end> text 格式。"""
        pattern = re.compile(
            r"<(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)>\s*(.*?)(?=<\d|$)", re.DOTALL
        )
        segments: list[Segment] = []
        for m in pattern.finditer(raw):
            segments.append(
                Segment(
                    start=float(m.group(1)),
                    end=float(m.group(2)),
                    text=m.group(3).strip(),
                )
            )
        return segments
