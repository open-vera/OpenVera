"""测试 scheduler.py 的 stop/pause 控制逻辑。"""
from __future__ import annotations

import threading
import time
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from audio_label.pipeline.scheduler import AnnotationScheduler, LLMConfig, LoadMonitor
from audio_label.transcribers import Segment, TranscribeResult


# ── Mock Transcriber ──────────────────────────────────────

class InstantTranscriber:
    """立即返回结果，记录处理过的文件。"""
    def __init__(self):
        self.processed: list[str] = []

    def transcribe(self, path: Path) -> TranscribeResult:
        self.processed.append(path.name)
        return TranscribeResult(
            text="测试",
            language="zh",
            segments=[Segment(0.0, 1.0, "测试")],
            words=[],
            chunks=[],
        )


class SlowTranscriber:
    """每个文件耗时 sleep_sec 秒，用于测试 stop/pause 时序。"""
    def __init__(self, sleep_sec: float = 0.2):
        self.processed: list[str] = []
        self.sleep_sec = sleep_sec

    def transcribe(self, path: Path) -> TranscribeResult:
        time.sleep(self.sleep_sec)
        self.processed.append(path.name)
        return TranscribeResult(
            text="测试",
            language="zh",
            segments=[Segment(0.0, 1.0, "测试")],
            words=[],
            chunks=[],
        )


def make_files(n: int, tmp_path: Path) -> list[Path]:
    files = []
    for i in range(n):
        p = tmp_path / f"audio_{i:02d}.wav"
        p.touch()
        files.append(p)
    return files


def make_scheduler(transcriber, stop_event=None, pause_event=None,
                   progress_events=None) -> AnnotationScheduler:
    events = progress_events if progress_events is not None else []
    return AnnotationScheduler(
        transcriber=transcriber,
        llm_config=None,
        monitor=LoadMonitor(initial_workers=1),
        progress_fn=lambda ev: events.append(ev),
        stop_event=stop_event,
        pause_event=pause_event,
    )


# ── 基本运行 ──────────────────────────────────────────────

def test_scheduler_processes_all_files(tmp_path):
    files = make_files(3, tmp_path)
    tr = InstantTranscriber()
    scheduler = make_scheduler(tr)
    records = scheduler.run_sync(files)
    assert len(records) == 3
    assert set(tr.processed) == {f.name for f in files}


def test_scheduler_emits_file_done_events(tmp_path):
    files = make_files(2, tmp_path)
    events = []
    scheduler = make_scheduler(InstantTranscriber(), progress_events=events)
    scheduler.run_sync(files)
    done_events = [e for e in events if e.get("event") == "file_done"]
    assert len(done_events) == 2


# ── stop_event ────────────────────────────────────────────

def test_stop_event_aborts_remaining_files(tmp_path):
    """stop_event 置位后，剩余文件不再处理。"""
    files = make_files(5, tmp_path)
    stop_event = threading.Event()
    tr = SlowTranscriber(sleep_sec=0.05)

    # 在后台线程中运行，主线程在第 2 个文件处理完后发 stop
    result_holder = []
    def run():
        s = make_scheduler(tr, stop_event=stop_event)
        result_holder.append(s.run_sync(files))

    t = threading.Thread(target=run, daemon=True)
    t.start()
    time.sleep(0.12)  # 等约 2 个文件完成
    stop_event.set()
    t.join(timeout=3)

    # 至少有 1 个文件被处理，但不应全部完成
    assert 1 <= len(tr.processed) < 5


def test_stop_event_already_set(tmp_path):
    """stop_event 预先置位时，不处理任何文件。"""
    files = make_files(3, tmp_path)
    stop_event = threading.Event()
    stop_event.set()
    tr = InstantTranscriber()
    scheduler = make_scheduler(tr, stop_event=stop_event)
    scheduler.run_sync(files)
    assert len(tr.processed) == 0


def test_no_stop_event_processes_all(tmp_path):
    """不传 stop_event 时正常跑完。"""
    files = make_files(3, tmp_path)
    tr = InstantTranscriber()
    make_scheduler(tr, stop_event=None).run_sync(files)
    assert len(tr.processed) == 3


# ── pause_event ───────────────────────────────────────────

def test_pause_then_resume(tmp_path):
    """暂停后文件停止处理，恢复后继续完成。"""
    files = make_files(6, tmp_path)
    pause_event = threading.Event()
    pause_event.set()  # 初始可运行
    tr = SlowTranscriber(sleep_sec=0.1)

    result_holder = []
    def run():
        s = make_scheduler(tr, pause_event=pause_event)
        result_holder.append(s.run_sync(files))

    t = threading.Thread(target=run, daemon=True)
    t.start()
    time.sleep(0.15)            # 等约 1-2 个文件完成
    count_before_pause = len(tr.processed)
    pause_event.clear()         # 暂停
    time.sleep(0.4)             # 等待足够时间，验证没有更多文件被处理
    count_during_pause = len(tr.processed)
    pause_event.set()           # 恢复
    t.join(timeout=5)

    # 暂停期间最多只多处理 1 个正在进行中的文件
    assert count_during_pause - count_before_pause <= 1
    # 恢复后应完成所有文件
    assert len(tr.processed) == 6


def test_pause_emits_paused_event(tmp_path):
    """暂停时应推送 paused 事件，恢复后推送 resumed 事件。"""
    files = make_files(3, tmp_path)
    pause_event = threading.Event()
    pause_event.set()
    tr = SlowTranscriber(sleep_sec=0.05)
    events = []

    def run():
        s = make_scheduler(tr, pause_event=pause_event, progress_events=events)
        s.run_sync(files)

    t = threading.Thread(target=run, daemon=True)
    t.start()
    time.sleep(0.06)
    pause_event.clear()
    time.sleep(0.15)
    pause_event.set()
    t.join(timeout=3)

    event_types = [e["event"] for e in events]
    assert "paused" in event_types
    assert "resumed" in event_types


# ── stop + pause 组合 ─────────────────────────────────────

def test_stop_while_paused(tmp_path):
    """暂停中收到 stop，应解除阻塞并终止。"""
    files = make_files(4, tmp_path)
    pause_event = threading.Event()
    stop_event = threading.Event()
    pause_event.set()
    tr = SlowTranscriber(sleep_sec=0.05)

    def run():
        s = make_scheduler(tr, stop_event=stop_event, pause_event=pause_event)
        s.run_sync(files)

    t = threading.Thread(target=run, daemon=True)
    t.start()
    time.sleep(0.08)
    pause_event.clear()   # 暂停
    time.sleep(0.05)
    stop_event.set()
    pause_event.set()     # 解除暂停，让 worker 检查 stop（模拟 /api/annotate/stop 行为）
    t.join(timeout=2)

    assert not t.is_alive(), "scheduler 线程应在 stop 后退出"
    assert len(tr.processed) < 4
