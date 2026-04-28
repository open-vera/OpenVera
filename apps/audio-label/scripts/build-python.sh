#!/usr/bin/env bash
# 构建 Python 二进制并放到 Tauri sidecar 目录
# 使用 Nuitka 将 Python 编译为原生二进制（比 PyInstaller .pyc 更难逆向）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BINARIES_DIR="$PROJECT_ROOT/gui/src-tauri/binaries"

# 检测架构
ARCH=$(uname -m)
case "$ARCH" in
  arm64)  TARGET_TRIPLE="aarch64-apple-darwin" ;;
  x86_64) TARGET_TRIPLE="x86_64-apple-darwin" ;;
  *)      echo "不支持的架构: $ARCH"; exit 1 ;;
esac

echo ""
echo "  构建 Python 二进制 (Nuitka)"
echo "  架构: $TARGET_TRIPLE"
echo ""

# 确保 .venv 存在并激活
VENV="$PROJECT_ROOT/.venv"
if [ ! -d "$VENV" ]; then
  echo "  错误：未找到 .venv，请先创建虚拟环境"
  exit 1
fi
source "$VENV/bin/activate"

# 确保 Nuitka 已安装
if ! python -c "import nuitka" 2>/dev/null; then
  echo "  安装 Nuitka..."
  pip install nuitka -q
fi

# ── Nuitka 编译 ─────────────────────────────────────────────
NUITKA_OUT="$PROJECT_ROOT/build/nuitka_out"
rm -rf "$NUITKA_OUT"
mkdir -p "$NUITKA_OUT"

echo "  [1/2] Nuitka 编译（首次编译较慢，约 3-10 分钟）..."
cd "$PROJECT_ROOT"

python -m nuitka \
  --onefile \
  --output-dir="$NUITKA_OUT" \
  --output-filename="veralabel" \
  --python-flag=no_docstrings \
  --python-flag=no_asserts \
  --follow-imports \
  --include-package=audio_label \
  --include-package=uvicorn \
  --include-package=fastapi \
  --include-package=starlette \
  --include-package=pydantic \
  --include-package=pydantic_core \
  --include-package=h11 \
  --include-package=anyio \
  --include-package=soundfile \
  --include-data-dir="$PROJECT_ROOT/prompts"="prompts" \
  --noinclude-setuptools-mode=nofollow \
  --noinclude-pytest-mode=nofollow \
  --noinclude-IPython-mode=nofollow \
  --noinclude-default-mode=nofollow \
  --nofollow-import-to=transformers \
  --nofollow-import-to=torch \
  --nofollow-import-to=torchaudio \
  --nofollow-import-to=mlx \
  --nofollow-import-to=mlx_lm \
  --nofollow-import-to=mlx_qwen3_asr \
  --nofollow-import-to=parakeet_mlx \
  --nofollow-import-to=pyannote \
  --nofollow-import-to=df \
  --nofollow-import-to=librosa \
  --nofollow-import-to=numpy \
  --nofollow-import-to=scipy \
  --assume-yes-for-downloads \
  "$PROJECT_ROOT/src/audio_label/__main__.py"

# 移动产出到 Tauri sidecar 目录
SIDECAR_NAME="veralabel-$TARGET_TRIPLE"
if [ -f "$NUITKA_OUT/veralabel" ]; then
  mkdir -p "$BINARIES_DIR"
  mv "$NUITKA_OUT/veralabel" "$BINARIES_DIR/$SIDECAR_NAME"
fi

echo ""
echo "  [2/2] 验证..."
if [ -f "$BINARIES_DIR/$SIDECAR_NAME" ]; then
  SIZE=$(du -sh "$BINARIES_DIR/$SIDECAR_NAME" | awk '{print $1}')
  echo "  ✓ 产出: $BINARIES_DIR/$SIDECAR_NAME ($SIZE)"
else
  echo "  ✗ 构建失败：未找到产出文件"
  exit 1
fi

echo ""
echo "  完成！"
