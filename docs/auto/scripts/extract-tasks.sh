#!/bin/bash
# extract-tasks.sh - 从 roadmap 提取未完成任务
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ROADMAP="$PROJECT_ROOT/P1-IMPLEMENTATION-PLAN.md"

if [ ! -f "$ROADMAP" ]; then
  echo "❌ 找不到 P1-IMPLEMENTATION-PLAN.md"
  exit 1
fi

echo "=== 待完成任务 ==="
echo ""

# 提取未完成的 checkbox 项（- [ ] 开头）
grep -n "^\- \[ \]" "$ROADMAP" | while IFS=: read -r line_num content; do
  # 提取 Phase 信息
  phase=$(head -n "$line_num" "$ROADMAP" | grep -E "^## Phase" | tail -1 | sed 's/## //')
  
  # 提取任务 ID（如 S1, CR1, T1 等）
  task_id=$(echo "$content" | grep -oE '\*\*[A-Z]+[0-9]+\*\*' | sed 's/\*\*//g')
  
  # 提取任务描述
  description=$(echo "$content" | sed 's/^- \[ \] \*\*[A-Z]*[0-9]*\*\* //')
  
  if [ -n "$task_id" ]; then
    echo "[$phase] $task_id - $description"
  fi
done

echo ""
echo "=== 统计 ==="
total=$(grep -c "^\- \[ \]" "$ROADMAP" || echo "0")
done_count=$(grep -c "^\- \[x\]" "$ROADMAP" || echo "0")
echo "待完成: $total"
echo "已完成: $done_count"
