"""Qwen3-ASR 后端（MLX，Apple Silicon）。"""

from __future__ import annotations

import json
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import IO

from audio_label.config import DEFAULT_MODEL_SIZE, MLX_MODEL_ID_TPL
from audio_label.transcribers import Segment, Transcriber, TranscribeResult

# Worker 脚本内容 —— 在 ML venv Python 中运行，绕过 Nuitka sys.path 限制
_WORKER_SCRIPT = """\
import sys, json, os

def main():
    line = sys.stdin.readline()
    req = json.loads(line)
    assert req["cmd"] == "init", f"expected init, got {req}"

    try:
        from mlx_qwen3_asr import Session
    except ImportError as e:
        sys.stdout.write(json.dumps({"status": "error", "message": str(e)}) + "\\n")
        sys.stdout.flush()
        return

    try:
        session = Session(model=req["model_id"])
    except Exception as e:
        sys.stdout.write(json.dumps({"status": "error", "message": str(e)}) + "\\n")
        sys.stdout.flush()
        return

    sys.stdout.write(json.dumps({"status": "ready"}) + "\\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        if req["cmd"] == "transcribe":
            try:
                result = session.transcribe(
                    req["path"], return_timestamps=True, return_chunks=True
                )
                chunks = []
                if result.chunks:
                    for ch in result.chunks:
                        chunks.append({
                            "start": ch.get("start", 0.0),
                            "end": ch.get("end", 0.0),
                            "text": ch.get("text", ""),
                        })
                segments = []
                if result.segments:
                    for seg in result.segments:
                        segments.append({
                            "start": seg.get("start", 0.0),
                            "end": seg.get("end", 0.0),
                            "text": seg.get("text", ""),
                        })
                sys.stdout.write(json.dumps({
                    "status": "ok",
                    "text": result.text,
                    "language": getattr(result, "language", None),
                    "chunks": chunks,
                    "segments": segments,
                }) + "\\n")
            except Exception as e:
                sys.stdout.write(json.dumps({"status": "error", "message": str(e)}) + "\\n")
            sys.stdout.flush()
        elif req["cmd"] == "exit":
            break

main()
"""

_worker_lock = threading.Lock()
_worker_proc: subprocess.Popen | None = None
_worker_stdin: IO[str] | None = None
_worker_stdout: IO[str] | None = None
_worker_script_path: str | None = None


def _get_worker_script_path() -> str:
    """将 worker 脚本写到临时文件并缓存路径。"""
    global _worker_script_path
    if _worker_script_path:
        return _worker_script_path
    f = tempfile.NamedTemporaryFile(
        mode="w", suffix=".py", prefix="qwen3_worker_", delete=False
    )
    f.write(_WORKER_SCRIPT)
    f.close()
    _worker_script_path = f.name
    return f.name


def _start_worker(model_id: str) -> None:
    """启动 ML venv Python worker 子进程。"""
    global _worker_proc, _worker_stdin, _worker_stdout

    from audio_label.infra.runtime import ml_venv_python
    python = ml_venv_python()
    script = _get_worker_script_path()

    _worker_proc = subprocess.Popen(
        [python, script],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    _worker_stdin = _worker_proc.stdin
    _worker_stdout = _worker_proc.stdout

    # 发送初始化命令
    _worker_stdin.write(json.dumps({"cmd": "init", "model_id": model_id}) + "\n")
    _worker_stdin.flush()

    # 等待 ready
    resp_line = _worker_stdout.readline()
    if not resp_line:
        stderr = _worker_proc.stderr.read()
        raise RuntimeError(f"Worker 子进程启动失败：{stderr}")
    resp = json.loads(resp_line)
    if resp.get("status") != "ready":
        msg = resp.get("message", "unknown error")
        if "mlx_qwen3_asr" in msg or "No module" in msg:
            raise RuntimeError(
                "mlx-qwen3-asr 未安装，请执行：pip install 'veralabel[mlx]'"
            )
        raise RuntimeError(f"Worker 初始化失败：{msg}")


def _call_worker(path: str) -> dict:
    """通过 worker 子进程转写音频。"""
    global _worker_proc, _worker_stdin, _worker_stdout

    assert _worker_stdin and _worker_stdout

    _worker_stdin.write(json.dumps({"cmd": "transcribe", "path": path}) + "\n")
    _worker_stdin.flush()

    resp_line = _worker_stdout.readline()
    if not resp_line:
        # 子进程崩溃
        stderr = _worker_proc.stderr.read() if _worker_proc else ""
        raise RuntimeError(f"Worker 子进程意外退出：{stderr}")
    return json.loads(resp_line)


def stop_worker() -> None:
    """关闭 worker 子进程（供外部在任务结束后调用）。"""
    global _worker_proc, _worker_stdin, _worker_stdout
    with _worker_lock:
        if _worker_stdin:
            try:
                _worker_stdin.write(json.dumps({"cmd": "exit"}) + "\n")
                _worker_stdin.flush()
                _worker_stdin.close()
            except Exception:
                pass
        if _worker_proc:
            try:
                _worker_proc.wait(timeout=5)
            except Exception:
                _worker_proc.kill()
        _worker_proc = None
        _worker_stdin = None
        _worker_stdout = None


class Qwen3Transcriber(Transcriber):
    """通过 mlx-qwen3-asr 调用 Qwen3-ASR 模型。

    - 开发模式：直接 import mlx_qwen3_asr（sys.path 完整）
    - 打包模式：通过 ML venv Python 子进程运行 worker，绕过 Nuitka sys.path 限制
    """

    def __init__(self, model_size: str = DEFAULT_MODEL_SIZE, **_kw: object) -> None:
        from audio_label.infra.runtime import is_bundled

        self._model_id = MLX_MODEL_ID_TPL.format(size=model_size)
        self._use_subprocess = is_bundled()

        if self._use_subprocess:
            with _worker_lock:
                if _worker_proc is None or _worker_proc.poll() is not None:
                    _start_worker(self._model_id)
        else:
            try:
                from mlx_qwen3_asr import Session
            except ImportError as e:
                raise RuntimeError(
                    "mlx-qwen3-asr 未安装，请执行：pip install 'veralabel[mlx]'"
                ) from e
            self._session = Session(model=self._model_id)

    def transcribe(self, path: Path) -> TranscribeResult:
        if self._use_subprocess:
            return self._transcribe_subprocess(path)
        return self._transcribe_direct(path)

    def _transcribe_subprocess(self, path: Path) -> TranscribeResult:
        with _worker_lock:
            resp = _call_worker(str(path))

        if resp.get("status") != "ok":
            raise RuntimeError(f"Worker 转写失败：{resp.get('message', 'unknown')}")

        chunks = [Segment(start=c["start"], end=c["end"], text=c["text"]) for c in resp.get("chunks", [])]
        words = [Segment(start=s["start"], end=s["end"], text=s["text"]) for s in resp.get("segments", [])]

        return self._build_result(
            text=resp.get("text", ""),
            language=resp.get("language"),
            chunks=chunks,
            words=words,
        )

    def _transcribe_direct(self, path: Path) -> TranscribeResult:
        result = self._session.transcribe(
            str(path), return_timestamps=True, return_chunks=True,
        )

        chunks = []
        if result.chunks:
            for ch in result.chunks:
                chunks.append(Segment(
                    start=ch.get("start", 0.0),
                    end=ch.get("end", 0.0),
                    text=ch.get("text", ""),
                ))

        words = []
        if result.segments:
            for seg in result.segments:
                words.append(Segment(
                    start=seg.get("start", 0.0),
                    end=seg.get("end", 0.0),
                    text=seg.get("text", ""),
                ))

        return self._build_result(
            text=result.text,
            language=getattr(result, "language", None),
            chunks=chunks,
            words=words,
        )

    def _build_result(
        self,
        text: str,
        language: str | None,
        chunks: list[Segment],
        words: list[Segment],
    ) -> TranscribeResult:
        if words:
            segments = self._merge_segments(
                [{"start": w.start, "end": w.end, "text": w.text} for w in words]
            )
        elif chunks:
            segments = list(chunks)
        else:
            segments = []

        return TranscribeResult(
            text=text,
            language=language,
            segments=segments,
            words=words,
            chunks=chunks,
        )

    @staticmethod
    def _segment_text(text: str) -> str:
        """对中文文本做 jieba 分词，在词语间加空格提升可读性。"""
        if not text:
            return text
        try:
            import jieba
            return " ".join(jieba.cut(text))
        except ImportError:
            return text

    @staticmethod
    def _merge_segments(raw: list[dict]) -> list[Segment]:
        """兜底：将逐字 segments 按时间间隔和标点合并为句子级别。
        只在 chunks 不可用时使用。时间取自原始对齐数据，精确度有保证。
        """
        import re
        if not raw:
            return []

        sentences: list[Segment] = []
        buf_text = ""
        buf_start = 0.0
        buf_end = 0.0
        last_end = 0.0

        for seg in raw:
            text = seg.get("text", "")
            start = float(seg.get("start", 0.0))
            end = float(seg.get("end", 0.0))

            # 时间间隔 > 0.5s 视为自然停顿，断句
            if buf_text and start - last_end > 0.5:
                sentences.append(Segment(start=buf_start, end=buf_end, text=buf_text.strip()))
                buf_text = ""

            if not buf_text:
                buf_start = start

            buf_text += text
            buf_end = end
            last_end = end

            # 遇到句末标点也断句
            if re.search(r"[。？！.?!\n]$", buf_text.strip()):
                sentences.append(Segment(start=buf_start, end=buf_end, text=buf_text.strip()))
                buf_text = ""

        if buf_text.strip():
            sentences.append(Segment(start=buf_start, end=buf_end, text=buf_text.strip()))

        return sentences
