# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec: 最小打包 core + server 依赖，排除 ML 框架。"""

import os
import glob
from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs

block_cipher = None

# soundfile 需要 libsndfile 动态库
sf_datas = collect_data_files("soundfile")
sf_bins = collect_dynamic_libs("soundfile")

# PyArmor runtime：若 src/ 下存在 pyarmor_runtime_* 则自动包含
pyarmor_hiddenimports = []
for d in glob.glob("src/pyarmor_runtime_*"):
    pyarmor_hiddenimports.append(os.path.basename(d))

a = Analysis(
    ["src/audio_label/__main__.py"],
    pathex=["src"],
    binaries=sf_bins,
    datas=sf_datas + [
        # 打包默认 prompts
        ("prompts", "prompts"),
    ],
    hiddenimports=[
        # PyArmor runtime（混淆构建时自动注入）
        *pyarmor_hiddenimports,
        # audio_label 子模块
        "audio_label.cli",
        "audio_label.server",
        "audio_label.config",
        "audio_label.scanner",
        "audio_label.annotator",
        "audio_label.exporter",
        "audio_label.preflight",
        "audio_label.runtime",
        "audio_label.transcribers",
        # uvicorn 懒加载模块
        "uvicorn.logging",
        "uvicorn.loops.auto",
        "uvicorn.loops.asyncio",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.http.h11_impl",
        "uvicorn.protocols.http.httptools_impl",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.protocols.websockets.wsproto_impl",
        "uvicorn.lifespan.on",
        "uvicorn.lifespan.off",
        # pydantic
        "pydantic",
        # multipart (FastAPI file upload)
        "multipart",
    ],
    excludes=[
        # ML 框架 — 由首次启动时安装到 venv
        "mlx", "mlx_lm", "mlx_qwen3_asr",
        "parakeet_mlx",
        "transformers", "torch", "torchaudio", "torchvision",
        "accelerate", "librosa",
        "tensorflow", "keras",
        # 不需要的大包
        "matplotlib", "PIL", "cv2",
        "IPython", "jupyter", "notebook",
        "pytest", "setuptools", "pip", "wheel",
        "tkinter", "_tkinter",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="veralabel",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,  # 需要 stdout 输出端口号
    target_arch="arm64",
)
