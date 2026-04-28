"""测试 annotator.py：annotate() 函数与 AnnotationRecord 结构。"""
from __future__ import annotations

from audio_label.pipeline.annotator import AnnotationRecord, annotate
from audio_label.pipeline.scanner import AudioFile
from audio_label.transcribers import Segment, TranscribeResult
from pathlib import Path


def _make_audio(path: str = "/audio/test.wav", duration: float = 5.0,
                sample_rate: int = 16000) -> AudioFile:
    return AudioFile(path=Path(path), duration_sec=duration,
                     sample_rate=sample_rate, channels=1)


def _make_result(text: str = "hello", language: str = "zh",
                 segments: list[Segment] | None = None) -> TranscribeResult:
    segs = segments or [Segment(0.0, 5.0, text)]
    return TranscribeResult(text=text, language=language, segments=segs, words=[], chunks=[])


# ── annotate() ───────────────────────────────────────────

def test_annotate_basic_fields():
    audio = _make_audio()
    result = _make_result()
    rec = annotate(audio, result)
    assert rec.file == "/audio/test.wav"
    assert rec.text == "hello"
    assert rec.language == "zh"
    assert rec.duration_sec == pytest.approx(5.0)
    assert rec.sample_rate == 16000


def test_annotate_segments_carried_over():
    segs = [Segment(0.0, 2.0, "A"), Segment(2.0, 5.0, "B")]
    audio = _make_audio()
    result = _make_result(segments=segs)
    rec = annotate(audio, result)
    assert len(rec.segments) == 2
    assert rec.segments[0].text == "A"


def test_annotate_no_label_by_default():
    rec = annotate(_make_audio(), _make_result())
    assert rec.label is None


def test_annotate_words_and_chunks_preserved():
    words = [Segment(0.0, 1.0, "hello"), Segment(1.0, 2.0, "world")]
    chunks = [Segment(0.0, 5.0, "hello world")]
    result = TranscribeResult(text="hello world", segments=[], words=words, chunks=chunks)
    rec = annotate(_make_audio(), result)
    assert len(rec.words) == 2
    assert len(rec.chunks) == 1


def test_annotate_none_language():
    result = TranscribeResult(text="", language=None, segments=[], words=[], chunks=[])
    rec = annotate(_make_audio(), result)
    assert rec.language is None


import pytest
