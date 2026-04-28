"""测试 CLI 命令（typer + CliRunner，不依赖真实模型）。"""
from __future__ import annotations

import json
import threading
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from typer.testing import CliRunner

from audio_label.cli import app
from audio_label.pipeline.annotator import AnnotationRecord
from audio_label.transcribers import Segment, TranscribeResult

runner = CliRunner(mix_stderr=False)


# ── 辅助 ──────────────────────────────────────────────────

def _make_record(path: str = "/a/b.wav") -> AnnotationRecord:
    return AnnotationRecord(
        file=path,
        text="测试",
        language="zh",
        duration_sec=3.0,
        sample_rate=16000,
        segments=[Segment(0.0, 3.0, "测试")],
        words=[],
        chunks=[],
    )


def _make_transcribe_result() -> TranscribeResult:
    return TranscribeResult(
        text="测试",
        language="zh",
        segments=[Segment(0.0, 3.0, "测试")],
        words=[],
        chunks=[],
    )


# ── version ───────────────────────────────────────────────

def test_version():
    result = runner.invoke(app, ["version"])
    assert result.exit_code == 0
    assert result.stdout.strip() != ""


# ── doctor ────────────────────────────────────────────────

def test_doctor_passes_when_preflight_ok():
    with patch("audio_label.cli.run_preflight", return_value=0) as mock_pf:
        result = runner.invoke(app, ["doctor"])
    mock_pf.assert_called_once_with(strict=True)
    assert result.exit_code == 0


def test_doctor_fails_when_preflight_fails():
    with patch("audio_label.cli.run_preflight", return_value=1):
        result = runner.invoke(app, ["doctor"])
    assert result.exit_code == 1


def test_doctor_no_strict():
    with patch("audio_label.cli.run_preflight", return_value=0) as mock_pf:
        runner.invoke(app, ["doctor", "--no-strict"])
    mock_pf.assert_called_once_with(strict=False)


def test_check_command_does_not_exist():
    """check 已改名为 doctor，旧命令不应存在。"""
    result = runner.invoke(app, ["check"])
    assert result.exit_code != 0


# ── serve hidden ──────────────────────────────────────────

def test_serve_not_in_help():
    """serve 是内部命令，不出现在 --help 中。"""
    result = runner.invoke(app, ["--help"])
    assert "serve" not in result.stdout


# ── prompts ───────────────────────────────────────────────

def test_prompts_empty_dir(tmp_path):
    result = runner.invoke(app, ["prompts", "--dir", str(tmp_path)])
    assert result.exit_code == 0
    assert "未找到" in result.stdout


def test_prompts_lists_md_files(tmp_path):
    (tmp_path / "纠错.md").write_text("请纠错以下转写内容", encoding="utf-8")
    (tmp_path / "翻译.md").write_text("翻译为英文", encoding="utf-8")
    result = runner.invoke(app, ["prompts", "--dir", str(tmp_path)])
    assert result.exit_code == 0
    assert "纠错" in result.stdout
    assert "翻译" in result.stdout


def test_prompts_nonexistent_dir(tmp_path):
    result = runner.invoke(app, ["prompts", "--dir", str(tmp_path / "no_such_dir")])
    assert result.exit_code == 0
    assert "不存在" in result.stdout


# ── annotate：无音频文件 ──────────────────────────────────

def test_annotate_no_files_found(tmp_path):
    with patch("audio_label.cli.run_preflight", return_value=0):
        result = runner.invoke(app, ["annotate", str(tmp_path), "--skip-check"])
    assert result.exit_code == 0
    assert "未找到" in result.stdout


# ── annotate：纯 ASR ──────────────────────────────────────

def _patch_asr(tmp_path: Path):
    """公共 patch 上下文：fake 转写器 + fake 扫描 + fake scheduler。"""
    from audio_label.pipeline.scanner import AudioFile

    fake_transcriber = MagicMock()
    fake_transcriber.transcribe.return_value = _make_transcribe_result()

    audio_files = [
        AudioFile(path=tmp_path / "a.wav", duration_sec=3.0, sample_rate=16000, channels=1),
    ]

    records = [_make_record(str(tmp_path / "a.wav"))]

    return fake_transcriber, audio_files, records


def test_annotate_asr_only_json(tmp_path):
    fake_transcriber, audio_files, records = _patch_asr(tmp_path)

    with (
        patch("audio_label.cli.run_preflight", return_value=0),
        patch("audio_label.scanner.scan_audio_files", return_value=audio_files),
        patch("audio_label.transcribers.create_transcriber", return_value=fake_transcriber),
        patch("audio_label.scheduler.AnnotationScheduler.run_sync", return_value=records),
    ):
        result = runner.invoke(app, [
            "annotate", str(tmp_path),
            "--skip-check",
            "--output", str(tmp_path / "out.jsonl"),
        ])

    assert result.exit_code == 0
    assert (tmp_path / "out.jsonl").exists()
    lines = (tmp_path / "out.jsonl").read_text().splitlines()
    assert len(lines) == 1


def test_annotate_asr_only_csv(tmp_path):
    fake_transcriber, audio_files, records = _patch_asr(tmp_path)

    with (
        patch("audio_label.cli.run_preflight", return_value=0),
        patch("audio_label.scanner.scan_audio_files", return_value=audio_files),
        patch("audio_label.transcribers.create_transcriber", return_value=fake_transcriber),
        patch("audio_label.scheduler.AnnotationScheduler.run_sync", return_value=records),
    ):
        result = runner.invoke(app, [
            "annotate", str(tmp_path),
            "--skip-check", "--format", "csv",
            "--output", str(tmp_path / "out.csv"),
        ])

    assert result.exit_code == 0
    assert (tmp_path / "out.csv").exists()


def test_annotate_asr_only_jsonl(tmp_path):
    fake_transcriber, audio_files, records = _patch_asr(tmp_path)

    with (
        patch("audio_label.cli.run_preflight", return_value=0),
        patch("audio_label.scanner.scan_audio_files", return_value=audio_files),
        patch("audio_label.transcribers.create_transcriber", return_value=fake_transcriber),
        patch("audio_label.scheduler.AnnotationScheduler.run_sync", return_value=records),
    ):
        result = runner.invoke(app, [
            "annotate", str(tmp_path),
            "--skip-check", "--format", "jsonl",
            "--output", str(tmp_path / "out.jsonl"),
        ])

    assert result.exit_code == 0
    lines = (tmp_path / "out.jsonl").read_text().splitlines()
    assert len(lines) == 1


# ── annotate：LLM 标注 ────────────────────────────────────

def test_annotate_llm_requires_prompt(tmp_path):
    with patch("audio_label.cli.run_preflight", return_value=0):
        result = runner.invoke(app, [
            "annotate", str(tmp_path),
            "--skip-check", "--llm-model", "qwen3.5:9b",
            # 故意不传 --llm-prompt
        ])
    assert result.exit_code != 0
    assert "llm-prompt" in result.stdout


def test_annotate_llm_prompt_not_found(tmp_path):
    with patch("audio_label.cli.run_preflight", return_value=0):
        result = runner.invoke(app, [
            "annotate", str(tmp_path),
            "--skip-check",
            "--llm-model", "qwen3.5:9b",
            "--llm-prompt", "不存在的提示词",
            "--prompts-dir", str(tmp_path),
        ])
    assert result.exit_code != 0
    assert "不存在" in result.stdout


def test_annotate_with_llm(tmp_path):
    (tmp_path / "纠错.md").write_text("请纠错转写内容", encoding="utf-8")
    fake_transcriber, audio_files, records = _patch_asr(tmp_path)

    with (
        patch("audio_label.cli.run_preflight", return_value=0),
        patch("audio_label.scanner.scan_audio_files", return_value=audio_files),
        patch("audio_label.transcribers.create_transcriber", return_value=fake_transcriber),
        patch("audio_label.scheduler.AnnotationScheduler.run_sync", return_value=records),
    ):
        result = runner.invoke(app, [
            "annotate", str(tmp_path),
            "--skip-check",
            "--llm-model", "qwen3.5:9b",
            "--llm-prompt", "纠错",
            "--prompts-dir", str(tmp_path),
            "--output", str(tmp_path / "out.json"),
        ])

    assert result.exit_code == 0
    assert "LLM 标注" in result.stdout

def test_annotate_asr_prompt_from_file(tmp_path):
    (tmp_path / "asr-correction.md").write_text("请纠错 ASR", encoding="utf-8")
    fake_transcriber, audio_files, records = _patch_asr(tmp_path)

    captured = {}

    def fake_create(backend, **kw):
        captured.update(kw)
        return fake_transcriber

    with (
        patch("audio_label.cli.run_preflight", return_value=0),
        patch("audio_label.scanner.scan_audio_files", return_value=audio_files),
        patch("audio_label.transcribers.create_transcriber", side_effect=fake_create),
        patch("audio_label.scheduler.AnnotationScheduler.run_sync", return_value=records),
    ):
        runner.invoke(app, [
            "annotate", str(tmp_path),
            "--skip-check",
            "--backend", "ollama:qwen3-vl:8b",
            "--asr-prompt", "asr-correction",
            "--prompts-dir", str(tmp_path),
            "--output", str(tmp_path / "out.json"),
        ])

    assert captured.get("prompt") == "请纠错 ASR"


def test_annotate_asr_prompt_inline(tmp_path):
    """--asr-prompt 传入的内容不是文件名时，直接作为提示词内容。"""
    fake_transcriber, audio_files, records = _patch_asr(tmp_path)
    captured = {}

    def fake_create(backend, **kw):
        captured.update(kw)
        return fake_transcriber

    with (
        patch("audio_label.cli.run_preflight", return_value=0),
        patch("audio_label.scanner.scan_audio_files", return_value=audio_files),
        patch("audio_label.transcribers.create_transcriber", side_effect=fake_create),
        patch("audio_label.scheduler.AnnotationScheduler.run_sync", return_value=records),
    ):
        runner.invoke(app, [
            "annotate", str(tmp_path),
            "--skip-check",
            "--backend", "ollama:qwen3-vl:8b",
            "--asr-prompt", "直接提示词内容",
            "--prompts-dir", str(tmp_path),  # tmp_path 无该文件 → 当内容用
            "--output", str(tmp_path / "out.json"),
        ])

    assert captured.get("prompt") == "直接提示词内容"


# ── annotate：未知后端 ────────────────────────────────────

def test_annotate_unknown_backend(tmp_path):
    result = runner.invoke(app, [
        "annotate", str(tmp_path),
        "--skip-check", "--backend", "unknown_backend",
    ])
    assert result.exit_code != 0
    assert "未知后端" in result.stdout
