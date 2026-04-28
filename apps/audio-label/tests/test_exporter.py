"""测试 exporter.py：CSV / JSONL 导出与 merge_export。"""
from __future__ import annotations

import csv
import json
from pathlib import Path

import pytest

from audio_label.pipeline.exporter import export_csv, export_jsonl, merge_export
from audio_label.transcribers import Segment


# ── export_csv ────────────────────────────────────────────

def test_export_csv_creates_file(tmp_path, record):
    out = tmp_path / "out.csv"
    export_csv([record], out)
    assert out.exists()


def test_export_csv_headers(tmp_path, record):
    out = tmp_path / "out.csv"
    export_csv([record], out)
    with out.open(encoding="utf-8") as f:
        reader = csv.DictReader(f)
        assert set(reader.fieldnames or []) >= {"file", "text", "language", "segments", "words", "chunks"}


def test_export_csv_segments_as_json_string(tmp_path, record):
    out = tmp_path / "out.csv"
    export_csv([record], out)
    with out.open(encoding="utf-8") as f:
        row = next(csv.DictReader(f))
    segs = json.loads(row["segments"])
    assert isinstance(segs, list)
    assert segs[0]["text"] == record.segments[0].text


def test_export_csv_empty_segments(tmp_path, record):
    record.segments = []
    record.words = []
    record.chunks = []
    out = tmp_path / "out.csv"
    export_csv([record], out)
    with out.open(encoding="utf-8") as f:
        row = next(csv.DictReader(f))
    assert row["segments"] == ""
    assert row["words"] == ""


def test_export_csv_label_as_json_string(tmp_path, record_with_label):
    out = tmp_path / "out.csv"
    export_csv([record_with_label], out)
    with out.open(encoding="utf-8") as f:
        row = next(csv.DictReader(f))
    label = json.loads(row["label"])
    assert label["prompt_name"] == "纠错"


# ── export_jsonl ──────────────────────────────────────────

def test_export_jsonl_creates_file(tmp_path, record):
    out = tmp_path / "out.jsonl"
    export_jsonl([record], out)
    assert out.exists()
    lines = out.read_text().splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0])["file"] == record.file


def test_export_jsonl_appends(tmp_path, record):
    import copy
    r2 = copy.deepcopy(record)
    r2.file = "/data/audio/test2.wav"
    out = tmp_path / "out.jsonl"
    export_jsonl([record], out)
    export_jsonl([r2], out)
    lines = out.read_text().splitlines()
    assert len(lines) == 2


# ── merge_export ──────────────────────────────────────────

def test_merge_export_basic(tmp_path):
    """records.jsonl + manual_annotations.json → final.jsonl"""
    rec = {"file": "/a/b.wav", "text": "测试", "segments": []}
    (tmp_path / "records.jsonl").write_text(json.dumps(rec) + "\n", encoding="utf-8")
    (tmp_path / "manual_annotations.json").write_text(
        json.dumps({"/a/b.wav": [{"start": 1.0, "end": 2.0, "value": "标注"}]}),
        encoding="utf-8",
    )
    out = merge_export(tmp_path)
    assert out.exists()
    merged = json.loads(out.read_text().splitlines()[0])
    assert merged["file"] == "/a/b.wav"
    assert len(merged["manual_annotations"]) == 1


def test_merge_export_corrections(tmp_path):
    rec = {"file": "/a/c.wav", "text": "hello"}
    (tmp_path / "records.jsonl").write_text(json.dumps(rec) + "\n", encoding="utf-8")
    corr = {"file": "/a/c.wav", "seg_start": 0.0, "seg_end": 1.0,
            "original": "hello", "corrected": "hell", "cer": 0.2}
    (tmp_path / "corrections.jsonl").write_text(json.dumps(corr) + "\n", encoding="utf-8")
    out = merge_export(tmp_path)
    merged = json.loads(out.read_text().splitlines()[0])
    assert merged["cer_avg"] == pytest.approx(0.2)
    assert len(merged["corrections"]) == 1


def test_merge_export_missing_sources(tmp_path):
    """无任何来源文件时应生成空的 final.jsonl"""
    out = merge_export(tmp_path)
    assert out.exists()
    assert out.read_text().strip() == ""


def test_merge_export_invalid_jsonl_lines(tmp_path):
    """含损坏行时跳过，不崩溃"""
    (tmp_path / "records.jsonl").write_text(
        'not-json\n{"file": "/ok.wav", "text": ""}\n', encoding="utf-8"
    )
    out = merge_export(tmp_path)
    lines = [l for l in out.read_text().splitlines() if l.strip()]
    assert len(lines) == 1
