from __future__ import annotations

import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from importlib.util import find_spec

from rich.console import Console

from audio_label.config import OLLAMA_MODEL_HINTS, URL_MLX, URL_OLLAMA, URL_QWEN_ASR
from audio_label.infra.runtime import inject_ml_venv, is_bundled, ml_venv_python

console = Console()


def _pip_install_prefix() -> str:
    """返回 pip install 的前缀命令。"""
    if is_bundled():
        return f"{ml_venv_python()} -m pip"
    return f"{sys.executable} -m pip"


def _python_exe() -> str:
    """返回用于 ML 操作的 Python 路径。"""
    if is_bundled():
        return ml_venv_python()
    return sys.executable


@dataclass
class CheckResult:
    name: str
    ok: bool
    detail: str
    install_cmd: str | None = None


def _which(cmd: str) -> str | None:
    return shutil.which(cmd)


def check_ollama_binary() -> CheckResult:
    path = _which("ollama")
    if path:
        return CheckResult("Ollama CLI", True, path)
    return CheckResult(
        "Ollama CLI",
        False,
        f"未在 PATH 中找到 ollama。请安装：{URL_OLLAMA}",
        install_cmd="brew install ollama",
    )


def check_ollama_models() -> CheckResult:
    if not _which("ollama"):
        return CheckResult("Ollama 模型", False, "跳过（未安装 Ollama）")
    try:
        out = subprocess.run(
            ["ollama", "list"],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        return CheckResult("Ollama 模型", False, f"无法执行 ollama list：{e}")
    if out.returncode != 0:
        err = (out.stderr or out.stdout or "").strip()
        return CheckResult("Ollama 模型", False, f"ollama list 失败：{err or out.returncode}")

    lines = out.stdout.strip().splitlines()
    if len(lines) < 2:
        return CheckResult(
            "Ollama 模型",
            False,
            "尚未拉取任何模型。建议至少安装与语音/标注相关的模型，例如：\n"
            "  ollama pull qwen2.5\n"
            "  （若官方提供语音/ASR 专用名，请按其文档拉取）",
            install_cmd="ollama pull qwen2.5",
        )

    # 表头 + 数据行；取第一列名称
    found: list[str] = []
    for line in lines[1:]:
        parts = re.split(r"\s+", line.strip(), maxsplit=1)
        if not parts:
            continue
        name = parts[0].lower()
        if any(h in name for h in OLLAMA_MODEL_HINTS):
            found.append(parts[0])

    if found:
        return CheckResult("Ollama 模型", True, "已检测到可能用于标注的模型：" + ", ".join(found[:8]))
    return CheckResult(
        "Ollama 模型",
        False,
        "已安装 Ollama，但未检测到常见语音/多模态相关模型（Qwen / Phi / Gemma 等关键词）。\n"
        f"请参考各厂商文档拉取模型，并浏览：{URL_QWEN_ASR}",
        install_cmd="ollama pull qwen2.5",
    )


def _can_import(module: str) -> bool:
    """检查指定模块是否可 import。bundled 模式下通过子进程检测（绕过 Nuitka sys.path 限制）。"""
    if is_bundled():
        py = ml_venv_python()
        try:
            r = subprocess.run(
                [py, "-c", f"import {module}"],
                capture_output=True, timeout=15,
            )
            return r.returncode == 0
        except Exception:
            return False
    inject_ml_venv()
    return find_spec(module) is not None


def check_mlx() -> CheckResult:
    if not _can_import("mlx"):
        pip = _pip_install_prefix()
        return CheckResult(
            "MLX (Python)",
            False,
            "当前 Python 未安装 mlx。Apple Silicon 上可执行：\n"
            f"  {pip} install 'veralabel[mlx]'\n"
            f"文档：{URL_MLX}",
            install_cmd=f"{pip} install 'veralabel[mlx]'",
        )
    return CheckResult("MLX (Python)", True, "已可 import mlx")


def check_mlx_asr_model() -> CheckResult:
    """检查 mlx-qwen3-asr 包是否安装。"""
    pip = _pip_install_prefix()
    py = _python_exe()
    if not _can_import("mlx_qwen3_asr"):
        return CheckResult(
            "Qwen3-ASR 模型 (MLX)",
            False,
            "mlx-qwen3-asr 未安装，这是 MLX 路径的 ASR 引擎。",
            install_cmd=f"{pip} install mlx-qwen3-asr",
        )
    # 检查模型权重是否已下载到 HuggingFace 缓存
    from pathlib import Path
    hf_cache = Path.home() / ".cache" / "huggingface" / "hub"
    # Qwen3-ASR-0.6B 的缓存目录名
    model_dirs = list(hf_cache.glob("models--Qwen--Qwen3-ASR-*")) if hf_cache.exists() else []
    if model_dirs:
        sizes = [d.name.split("ASR-")[-1] for d in model_dirs]
        return CheckResult(
            "Qwen3-ASR 模型 (MLX)",
            True,
            f"已下载模型权重：{', '.join(sizes)}",
        )
    return CheckResult(
        "Qwen3-ASR 模型 (MLX)",
        False,
        "mlx-qwen3-asr 已安装，但模型权重尚未下载。首次运行时会自动下载（约 1.2GB）。\n"
        "也可手动触发：python -c \"from mlx_qwen3_asr import Session; Session()\"",
        install_cmd=f"{py} -c \"from mlx_qwen3_asr import Session; Session()\"",
    )


def check_forced_aligner() -> CheckResult:
    """检查 Qwen3-ForcedAligner 模型权重是否已下载（时间戳对齐需要）。"""
    from pathlib import Path
    hf_cache = Path.home() / ".cache" / "huggingface" / "hub"
    aligner_dirs = list(hf_cache.glob("models--Qwen--Qwen3-ForcedAligner-*")) if hf_cache.exists() else []
    if aligner_dirs:
        sizes = [d.name.split("ForcedAligner-")[-1] for d in aligner_dirs]
        return CheckResult(
            "时间戳对齐模型",
            True,
            f"已下载 ForcedAligner 权重：{', '.join(sizes)}",
        )
    # 未下载 — 提供预下载命令
    return CheckResult(
        "时间戳对齐模型",
        False,
        "Qwen3-ForcedAligner 未下载，转写时间戳功能需要此模型（约 600MB）。",
        install_cmd=f'{_python_exe()} -c "from huggingface_hub import snapshot_download; snapshot_download(\'Qwen/Qwen3-ForcedAligner-0.6B\')"',
    )


def check_pyannote() -> CheckResult:
    """检查 pyannote.audio 和 HuggingFace Token 是否就绪（说话人分离需要）。"""
    pip = _pip_install_prefix()
    if find_spec("pyannote") is None:
        return CheckResult(
            "说话人分离 (pyannote)",
            False,
            "pyannote.audio 未安装（可选，用于多说话人分离）。",
            install_cmd=f"{pip} install pyannote.audio torch",
        )
    import os
    token = os.environ.get("HUGGINGFACE_HUB_TOKEN") or os.environ.get("HF_TOKEN")
    if not token:
        return CheckResult(
            "说话人分离 (pyannote)",
            False,
            "pyannote.audio 已安装，但缺少 HuggingFace Token。\n"
            "请访问 https://hf.co/pyannote/speaker-diarization-3.1 接受许可，\n"
            "然后设置环境变量 HUGGINGFACE_HUB_TOKEN=hf_xxxxxxxx",
            install_cmd=None,
        )
    return CheckResult("说话人分离 (pyannote)", True, "pyannote.audio 已安装且 HF Token 已配置")


def check_deepfilternet() -> CheckResult:
    """检查 deepfilternet 是否安装（音频降噪预处理需要）。"""
    pip = _pip_install_prefix()
    if find_spec("df") is None:
        return CheckResult(
            "音频降噪 (DeepFilterNet)",
            False,
            "deepfilternet 未安装（可选，用于嘈杂音频降噪预处理）。",
            install_cmd=f"{pip} install deepfilternet",
        )
    return CheckResult("音频降噪 (DeepFilterNet)", True, "deepfilternet 已安装")


def check_homebrew() -> CheckResult:
    """检查 macOS 上是否安装了 Homebrew（安装 python3/ffmpeg/ollama 的前提）。"""
    path = _which("brew")
    if path:
        return CheckResult("Homebrew", True, path)
    return CheckResult(
        "Homebrew",
        False,
        "未安装 Homebrew。安装 Python 3、ffmpeg、Ollama 均需要 Homebrew。",
        install_cmd='/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
    )


def check_python3() -> CheckResult:
    """检查系统是否有可用的 python3（bundled 模式下创建 ML venv 所需）。"""
    path = _which("python3")
    if path:
        try:
            out = subprocess.run(
                [path, "--version"],
                capture_output=True, text=True, timeout=10,
            )
            version = (out.stdout or out.stderr).strip()
            return CheckResult("Python 3", True, f"{path}  {version}")
        except Exception:
            return CheckResult("Python 3", True, path)
    return CheckResult(
        "Python 3",
        False,
        "未在 PATH 中找到 python3。安装 MLX 等 Python 依赖需要先安装 Python 3。",
        install_cmd="brew install python3",
    )


def check_ml_venv() -> CheckResult:
    """检查 ML venv 是否已创建（bundled 模式）。非 bundled 模式直接跳过。"""
    from audio_label.infra.runtime import ensure_ml_venv, is_bundled, ml_venv_dir
    if not is_bundled():
        venv = ml_venv_dir()
        return CheckResult("ML Python 环境", True, f"开发模式，使用当前 Python（{sys.executable}）")
    venv = ml_venv_dir()
    if (venv / "bin" / "python3").exists():
        return CheckResult("ML Python 环境", True, str(venv / "bin" / "python3"))
    # venv 不存在，检查 python3 可用性后尝试创建
    if not _which("python3"):
        return CheckResult(
            "ML Python 环境",
            False,
            f"ML 运行环境未创建（{venv}），且未找到 python3，无法初始化。",
            install_cmd="brew install python3",
        )
    return CheckResult(
        "ML Python 环境",
        False,
        f"ML 运行环境未创建（{venv}）。",
        install_cmd=f"python3 -m venv '{venv}' && '{venv}/bin/pip' install --upgrade pip",
    )


def check_ffmpeg() -> CheckResult:
    path = _which("ffmpeg")
    if path:
        return CheckResult("ffmpeg", True, path)
    return CheckResult(
        "ffmpeg",
        False,
        "未安装 ffmpeg，非 WAV 音频格式需要此依赖。",
        install_cmd="brew install ffmpeg",
    )


def run_preflight(*, strict: bool = True) -> int:
    """
    运行环境预检。strict=True 时：Ollama 与 MLX 至少满足一种可用路径，且对应侧模型/依赖到位。
    当前策略：
    - 必须能 import mlx（本地 ASR 主线，与 PRD 一致），或
    - 已安装 Ollama 且 ollama list 中有候选模型

    若两者都不满足，返回非 0 并打印指引。
    """
    results: list[CheckResult] = [
        check_homebrew(),
        check_python3(),
        check_ml_venv(),
        check_ollama_binary(),
        check_ollama_models(),
        check_mlx(),
        check_mlx_asr_model(),
        check_forced_aligner(),
        check_ffmpeg(),
        check_pyannote(),
        check_deepfilternet(),
    ]

    console.print("\n[bold]音频标注环境预检[/bold]\n")
    for r in results:
        mark = "[green]✓[/green]" if r.ok else "[red]✗[/red]"
        console.print(f"  {mark} [bold]{r.name}[/bold]")
        for sub in r.detail.splitlines():
            console.print(f"      {sub}", markup=False)

    ollama_ok = results[3].ok and results[4].ok
    mlx_ok = results[5].ok and results[6].ok

    if ollama_ok or mlx_ok:
        console.print("\n[green]环境可用：已满足 Ollama 或 MLX 路径之一。[/green]")
        if mlx_ok and not ollama_ok:
            console.print(
                "[dim]提示：使用 MLX 时请确保已按文档下载 Qwen3-ASR 等权重到本地。[/dim]"
            )
        if ollama_ok and not mlx_ok:
            console.print("[dim]提示：未安装 MLX 时，可将 Ollama 作为推理后端（后续版本可接）。[/dim]")
        return 0

    console.print("\n[red]当前无法开始标注：请至少完成以下之一。[/red]")
    console.print(
        "  1) 安装 Ollama 并拉取 Qwen / Phi / Gemma 等模型\n"
        "  2) 在 Apple Silicon 上安装 MLX：pip install 'veralabel[mlx]'，并准备 ASR 权重\n"
        f"\n链接：Ollama {URL_OLLAMA} ｜ MLX {URL_MLX} ｜ Qwen ASR {URL_QWEN_ASR}",
        markup=False,
    )
    return 1 if strict else 0
