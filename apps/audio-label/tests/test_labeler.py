"""测试 labeler.py 中的纯函数逻辑。"""
from __future__ import annotations

import pytest

from audio_label.pipeline.labeler import _extract_confidence, _format_segments, _parse_sections


# ── _format_segments ──────────────────────────────────────

def test_format_segments_empty():
    assert _format_segments([]) == ""


def test_format_segments_single():
    segs = [{"start": 0.0, "end": 3.5, "text": "你好"}]
    result = _format_segments(segs)
    assert "0:00.0" in result
    assert "0:03.5" in result
    assert "你好" in result


def test_format_segments_multiple():
    segs = [
        {"start": 0.0, "end": 3.5, "text": "你好，吃点啥？"},
        {"start": 3.5, "end": 6.0, "text": "爸，吃啥？"},
        {"start": 65.0, "end": 70.1, "text": "跨分钟文本"},
    ]
    lines = _format_segments(segs).splitlines()
    assert len(lines) == 3
    # 第三条跨分钟，分钟部分应为 1:
    assert lines[2].startswith("[1:")


def test_format_segments_zero_duration():
    segs = [{"start": 0.0, "end": 0.0, "text": ""}]
    result = _format_segments(segs)
    assert result  # 不应崩溃


# ── _extract_confidence ───────────────────────────────────

def test_extract_confidence_missing():
    text = "## 纠错\n内容正确"
    cleaned, conf = _extract_confidence(text)
    assert cleaned == text
    assert conf is None


def test_extract_confidence_valid():
    text = (
        "## 纠错\n内容正确\n"
        "<CONFIDENCE>\n"
        '{"overall": 0.85, "labels": {"纠错": 0.9}}\n'
        "</CONFIDENCE>"
    )
    cleaned, conf = _extract_confidence(text)
    assert "<CONFIDENCE>" not in cleaned
    assert conf is not None
    assert conf["overall"] == pytest.approx(0.85)
    assert conf["labels"]["纠错"] == pytest.approx(0.9)


def test_extract_confidence_invalid_json():
    text = "<CONFIDENCE>\nnot-json\n</CONFIDENCE>"
    cleaned, conf = _extract_confidence(text)
    assert conf is None  # 解析失败时返回 None


def test_extract_confidence_removes_block_from_text():
    text = "前缀\n<CONFIDENCE>\n{\"overall\": 1.0}\n</CONFIDENCE>\n后缀不存在"
    cleaned, conf = _extract_confidence(text)
    assert "前缀" in cleaned
    assert "CONFIDENCE" not in cleaned
    assert conf["overall"] == 1.0


# ── _parse_sections ───────────────────────────────────────

def test_parse_sections_empty():
    assert _parse_sections("无标题内容") == {}


def test_parse_sections_single():
    text = "## 纠错\n修正后的文本"
    sections = _parse_sections(text)
    assert "纠错" in sections
    assert sections["纠错"] == "修正后的文本"


def test_parse_sections_multiple():
    text = "## 纠错\n内容A\n## 说话人\n内容B"
    sections = _parse_sections(text)
    assert set(sections.keys()) == {"纠错", "说话人"}
    assert sections["纠错"] == "内容A"
    assert sections["说话人"] == "内容B"


def test_parse_sections_strips_whitespace():
    text = "## 标题  \n\n  内容有空格  \n\n"
    sections = _parse_sections(text)
    assert "标题" in sections
    assert sections["标题"] == "内容有空格"
