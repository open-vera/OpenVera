"""说话人分离模块：基于 pyannote.audio 的声学说话人识别。

pyannote/speaker-diarization-3.1 需要 HuggingFace token（申请方式：
https://hf.co/pyannote/speaker-diarization-3.1 → 接受许可协议）。
Token 通过环境变量 HUGGINGFACE_HUB_TOKEN 或 HF_TOKEN 配置。

安装依赖：
    pip install pyannote.audio torch
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass
class DiarSegment:
    start: float
    end: float
    speaker: str  # e.g. "SPEAKER_00"


def is_available() -> bool:
    """检查 pyannote.audio 是否已安装。"""
    from importlib.util import find_spec
    return find_spec("pyannote") is not None


def _get_hf_token() -> str | None:
    return os.environ.get("HUGGINGFACE_HUB_TOKEN") or os.environ.get("HF_TOKEN")


# 模块级 pipeline 缓存（避免重复加载，每次加载约 2-5 秒）
_pipeline_cache: object | None = None


def _load_pipeline():
    global _pipeline_cache
    if _pipeline_cache is not None:
        return _pipeline_cache

    try:
        from pyannote.audio import Pipeline
    except ImportError:
        raise ImportError(
            "pyannote.audio 未安装。请执行：\n"
            "  pip install pyannote.audio torch"
        )

    token = _get_hf_token()
    if not token:
        raise RuntimeError(
            "说话人分离需要 HuggingFace Token。\n"
            "请访问 https://hf.co/pyannote/speaker-diarization-3.1 接受许可，\n"
            "然后设置环境变量：HUGGINGFACE_HUB_TOKEN=hf_xxxxxxxx"
        )

    logger.info("[Diarization] 加载 pyannote/speaker-diarization-3.1 pipeline…")
    _pipeline_cache = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1",
        use_auth_token=token,
    )
    logger.info("[Diarization] Pipeline 加载完成")
    return _pipeline_cache


def diarize(
    audio_path: Path,
    num_speakers: int | None = None,
) -> list[DiarSegment]:
    """对单个音频文件执行说话人分离。

    Args:
        audio_path: 音频文件路径（支持 WAV / MP3 / M4A 等常见格式）
        num_speakers: 已知说话人数量，None 表示自动推断

    Returns:
        按时间排序的 DiarSegment 列表

    Raises:
        ImportError: pyannote.audio 未安装
        RuntimeError: 缺少 HF token 或模型加载失败
    """
    pipeline = _load_pipeline()

    kwargs: dict = {}
    if num_speakers is not None:
        kwargs["num_speakers"] = num_speakers

    logger.info(f"[Diarization] 分析 {audio_path.name}（num_speakers={num_speakers}）")
    diarization = pipeline(str(audio_path), **kwargs)

    segments: list[DiarSegment] = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        segments.append(DiarSegment(
            start=round(turn.start, 3),
            end=round(turn.end, 3),
            speaker=speaker,
        ))
    segments.sort(key=lambda s: s.start)

    n_speakers = len({s.speaker for s in segments})
    logger.info(f"[Diarization] 完成：{len(segments)} 段，{n_speakers} 个说话人")
    return segments


def merge_with_asr(
    diar_segments: list[DiarSegment],
    asr_segments: list[dict],
) -> list[dict]:
    """将说话人标签合并到 ASR segments 中。

    策略：对每个 ASR segment，找与其时间区间重叠最长的说话人段，取其 speaker。
    若无任何重叠则标记为 "UNKNOWN"。

    Args:
        diar_segments: diarize() 返回的说话人段列表
        asr_segments: ASR 返回的 segments（每项含 start/end/text）

    Returns:
        每项增加 "speaker" 字段的 segments 列表
    """
    result = []
    for seg in asr_segments:
        seg_start = seg.get("start", 0.0)
        seg_end = seg.get("end", seg_start)
        best_speaker = "UNKNOWN"
        best_overlap = 0.0

        for ds in diar_segments:
            overlap = min(seg_end, ds.end) - max(seg_start, ds.start)
            if overlap > best_overlap:
                best_overlap = overlap
                best_speaker = ds.speaker

        result.append({**seg, "speaker": best_speaker})
    return result
