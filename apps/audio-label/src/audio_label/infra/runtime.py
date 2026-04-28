"""运行时环境检测：区分开发模式与 PyInstaller 打包模式。"""

import os
import subprocess
import sys
from pathlib import Path


def is_bundled() -> bool:
    """当前是否运行在打包的二进制中。"""
    return getattr(sys, "frozen", False) or os.environ.get("AUDIO_LABEL_BUNDLED") == "1"


def inject_system_path() -> None:
    """打包模式下补全 PATH，确保 ollama/ffmpeg 等工具可被 shutil.which 找到。"""
    if not is_bundled():
        return
    extra = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    current = os.environ.get("PATH", "")
    existing = set(current.split(":"))
    additions = [p for p in extra if p not in existing]
    if additions:
        os.environ["PATH"] = ":".join(additions) + ":" + current


def data_dir() -> Path:
    """用户本地数据目录，存放 ML venv、日志、prompts 等。"""
    if d := os.environ.get("AUDIO_LABEL_DATA_DIR"):
        return Path(d)
    return Path.home() / "Library" / "Application Support" / "com.vera.veralabel"


def ml_venv_dir() -> Path:
    """ML 依赖安装的 venv 路径。"""
    return data_dir() / "venv"


def ml_venv_python() -> str:
    """ML venv 的 Python 解释器路径。开发模式返回 sys.executable。"""
    if not is_bundled():
        return sys.executable
    p = ml_venv_dir() / "bin" / "python3"
    return str(p) if p.exists() else sys.executable


def ml_venv_pip() -> str:
    """ML venv 的 pip 路径。"""
    if not is_bundled():
        return f"{sys.executable} -m pip"
    return str(ml_venv_dir() / "bin" / "pip")


def inject_ml_venv() -> None:
    """将 ML venv 的 site-packages 注入 sys.path（仅 bundled 模式）。"""
    if not is_bundled():
        return
    venv = ml_venv_dir()
    lib_dir = venv / "lib"
    if not lib_dir.exists():
        return
    for d in lib_dir.iterdir():
        if d.name.startswith("python3"):
            sp = d / "site-packages"
            if sp.exists() and str(sp) not in sys.path:
                sys.path.insert(0, str(sp))
            break


def logs_dir() -> Path:
    """统一日志目录，所有日志文件写入此处。"""
    return data_dir() / "logs"


def ensure_ml_venv() -> Path:
    """创建 ML venv（如果不存在）。返回 venv 路径。"""
    venv = ml_venv_dir()
    if (venv / "bin" / "python3").exists():
        return venv
    venv.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["python3", "-m", "venv", str(venv)], check=True)
    # 升级 pip
    subprocess.run(
        [str(venv / "bin" / "pip"), "install", "--upgrade", "pip"],
        check=True,
        capture_output=True,
    )
    return venv
