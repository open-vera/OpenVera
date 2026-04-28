"""共享 fixture。"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import pytest

from audio_label.pipeline.annotator import AnnotationRecord
from audio_label.pipeline.labeler import LabelResult
from audio_label.transcribers import Segment


# ── 基础数据 fixture ──────────────────────────────────────

@pytest.fixture
def seg():
    return Segment(start=0.0, end=3.5, text="你好世界")


@pytest.fixture
def segments():
    return [
        Segment(start=0.0, end=3.5, text="你好，吃点啥？"),
        Segment(start=3.5, end=6.0, text="爸，吃啥？"),
        Segment(start=6.0, end=10.2, text="自己点，来个榴莲披萨。"),
    ]


@pytest.fixture
def record(segments):
    return AnnotationRecord(
        file="/data/audio/test.wav",
        text="你好，吃点啥？爸，吃啥？自己点，来个榴莲披萨。",
        language="zh",
        duration_sec=10.2,
        sample_rate=16000,
        segments=segments,
        words=[],
        chunks=[],
    )


@pytest.fixture
def record_with_label(record):
    record.label = LabelResult(
        prompt_name="纠错",
        model="qwen3.5:9b",
        result="## 纠错\n内容正确无误。",
        label_confidence={"overall": 0.9, "labels": {"纠错": 0.9}},
    )
    return record
