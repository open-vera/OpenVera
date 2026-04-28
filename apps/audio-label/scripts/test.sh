#!/usr/bin/env bash
# 运行自动化测试
set -euo pipefail
cd "$(dirname "$0")/.."

source .venv/bin/activate 2>/dev/null || true

exec pytest tests/ "$@"
