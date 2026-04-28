"""Google Gemma 4 后端（Transformers 多模态，E2B/E4B）。"""

from __future__ import annotations

from pathlib import Path

from audio_label.config import GEMMA_MODEL_ID
from audio_label.transcribers import Segment, Transcriber, TranscribeResult

# Gemma 4 音频限制 30 秒
_MAX_AUDIO_SEC = 30

_TRANSCRIBE_PROMPT = (
    "Transcribe the following speech segment in its original language. "
    "Only output the transcription, with no newlines. "
    "When transcribing numbers, write the digits."
)


class GemmaTranscriber(Transcriber):
    """通过 HuggingFace Transformers 调用 Gemma 4 E2B/E4B 多模态模型。

    注意：音频上限 30 秒，适合短音频。长音频会自动截断并发出警告。
    """

    def __init__(self, model_id: str = GEMMA_MODEL_ID, **_kw: object) -> None:
        try:
            from transformers import AutoModelForMultimodalLM, AutoProcessor
        except ImportError as e:
            raise RuntimeError(
                "transformers 未安装或版本过低，请执行：pip install 'veralabel[gemma]'"
            ) from e

        self._processor = AutoProcessor.from_pretrained(model_id)
        self._model = AutoModelForMultimodalLM.from_pretrained(
            model_id, dtype="auto", device_map="auto"
        )

    def transcribe(self, path: Path) -> TranscribeResult:
        import torch
        import librosa

        audio, sr = librosa.load(str(path), sr=16000, mono=True)
        duration = len(audio) / sr

        if duration > _MAX_AUDIO_SEC:
            from rich.console import Console
            Console(stderr=True).print(
                f"[yellow]Gemma 4 限制 {_MAX_AUDIO_SEC}s，已截断 {path.name}（原 {duration:.1f}s）[/yellow]"
            )
            audio = audio[: int(_MAX_AUDIO_SEC * sr)]
            duration = _MAX_AUDIO_SEC

        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "audio", "audio": audio, "sample_rate": sr},
                    {"type": "text", "text": _TRANSCRIBE_PROMPT},
                ],
            }
        ]

        inputs = self._processor.apply_chat_template(
            messages,
            tokenize=True,
            return_dict=True,
            return_tensors="pt",
            add_generation_prompt=True,
        ).to(self._model.device)

        input_len = inputs["input_ids"].shape[-1]

        with torch.no_grad():
            outputs = self._model.generate(**inputs, max_new_tokens=512)

        text = self._processor.decode(
            outputs[0][input_len:], skip_special_tokens=True
        ).strip()

        return TranscribeResult(
            text=text,
            language=None,
            segments=[Segment(start=0.0, end=duration, text=text)] if text else [],
        )
