"""Ollama 多模态 ASR 后端：通过 Ollama API 调用多模态模型进行语音转写。"""

from __future__ import annotations

from pathlib import Path

import soundfile as sf

from audio_label.infra.ollama import audio_to_base64, ollama_chat
from audio_label.transcribers import Segment, Transcriber, TranscribeResult


_TRANSCRIBE_PROMPT = (
    "请将这段音频的内容转写为文本。要求：\n"
    "- 忠实还原语音内容，不添加、不省略\n"
    "- 数字使用阿拉伯数字\n"
    "- 保留语气词和停顿标记\n"
    "- 只输出转写文本，不要解释"
)


class OllamaTranscriber(Transcriber):
    """通过 Ollama 多模态 API 调用模型进行语音转写。

    适用于 qwen3-vl 等支持音频输入的多模态模型。
    注意：无 word 级时间戳，前端会降级为均匀分配。
    """

    def __init__(self, model: str, prompt: str | None = None, **_kw: object) -> None:
        self._model = model
        self._prompt = prompt or _TRANSCRIBE_PROMPT

    def transcribe(self, path: Path) -> TranscribeResult:
        # 获取音频时长
        info = sf.info(str(path))
        duration = info.duration

        # 编码音频为 base64
        audio_b64 = audio_to_base64(path)

        # 调用 Ollama 多模态 chat API
        # Ollama 使用 images 字段传递二进制数据（音频/图片）
        messages = [
            {
                "role": "user",
                "content": self._prompt,
                "images": [audio_b64],
            }
        ]

        text = ollama_chat(self._model, messages)
        text = text.strip()

        # Ollama 无法提供时间戳，创建单个 segment 覆盖全文
        segments = [Segment(start=0.0, end=duration, text=text)] if text else []

        return TranscribeResult(
            text=text,
            language=None,
            segments=segments,
            words=[],
            chunks=[],
        )
