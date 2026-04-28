#!/usr/bin/env bash
# 启动后端开发服务
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d ".venv" ]; then
  echo "错误：未找到 .venv，请先运行："
  echo "  python3.12 -m venv .venv && source .venv/bin/activate"
  echo "  pip install -e '.[mlx,server,dev]'"
  exit 1
fi

source .venv/bin/activate
exec veralabel serve --host 127.0.0.1 --port 1420
