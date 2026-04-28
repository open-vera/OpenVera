#!/usr/bin/env bash
# 首次 / 更新后一键安装所有开发依赖
set -euo pipefail
cd "$(dirname "$0")/.."

echo ">>> 检查 Python 3.12..."
if ! command -v python3.12 &>/dev/null; then
  echo "未找到 python3.12，请先执行：brew install python@3.12"
  exit 1
fi

echo ">>> 创建 / 复用虚拟环境..."
[ -d .venv ] || python3.12 -m venv .venv
source .venv/bin/activate

echo ">>> 安装 Python 依赖（mlx + server + dev）..."
pip install -q -e ".[mlx,server,dev]"

echo ">>> 安装前端依赖..."
cd gui && npm install --silent
cd ..

echo ""
echo "✓ 完成！开发环境已就绪。"
echo ""
echo "  启动后端（独立终端）:  bash scripts/dev-server.sh"
echo "  启动 GUI 开发模式:     cd gui && npm run tauri dev"
echo "  或一体启动（推荐）:    cd gui && npm run tauri dev"
echo "  运行测试:              bash scripts/test.sh"
