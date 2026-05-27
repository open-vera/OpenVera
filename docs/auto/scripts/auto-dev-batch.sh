#!/bin/bash
# auto-dev-batch.sh - 批量开发（串行处理一个 Phase）
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ROADMAP="$PROJECT_ROOT/P1-IMPLEMENTATION-PLAN.md"

# 检查参数
if [ -z "$1" ]; then
  echo "用法: $0 <phase-number>"
  echo "例如: $0 1"
  exit 1
fi

PHASE_NUM="$1"

# 提取指定 Phase 的任务
extract_phase_tasks() {
  local phase_num=$1
  
  # 查找 Phase 标题
  phase_start=$(grep -n "^## Phase ${phase_num}:" "$ROADMAP" | head -1 | cut -d: -f1)
  
  if [ -z "$phase_start" ]; then
    echo "❌ 找不到 Phase $phase_num"
    exit 1
  fi
  
  # 查找下一个 Phase 标题（或文件结尾）
  phase_end=$(tail -n +$((phase_start + 1)) "$ROADMAP" | grep -n "^## Phase" | head -1 | cut -d: -f1)
  
  if [ -z "$phase_end" ]; then
    phase_end=$(wc -l < "$ROADMAP")
  else
    phase_end=$((phase_start + phase_end - 1))
  fi
  
  # 提取未完成的任务 ID
  sed -n "${phase_start},${phase_end}p" "$ROADMAP" | \
    grep "^\- \[ \]" | \
    grep -oE '\*\*[A-Z]+[0-9]+\*\*' | \
    sed 's/\*\*//g'
}

# 主流程
main() {
  cd "$PROJECT_ROOT"
  
  echo "=== 批量开发: Phase $PHASE_NUM ==="
  echo ""
  
  # 提取任务列表
  tasks=$(extract_phase_tasks "$PHASE_NUM")
  
  if [ -z "$tasks" ]; then
    echo "✅ Phase $PHASE_NUM 没有待完成任务"
    exit 0
  fi
  
  echo "待完成任务:"
  echo "$tasks" | while read -r task_id; do
    echo "  - $task_id"
  done
  echo ""
  
  # 串行处理每个任务
  failed_tasks=()
  
  echo "$tasks" | while read -r task_id; do
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🚀 开始任务: $task_id"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    
    if "$SCRIPT_DIR/auto-dev.sh" "$task_id"; then
      echo "✅ 任务 $task_id 完成"
    else
      echo "❌ 任务 $task_id 失败"
      failed_tasks+=("$task_id")
    fi
  done
  
  # 汇总结果
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "📊 批量开发完成"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  
  if [ ${#failed_tasks[@]} -eq 0 ]; then
    echo "✅ 所有任务完成"
  else
    echo "❌ 失败任务:"
    for task_id in "${failed_tasks[@]}"; do
      echo "  - $task_id"
    done
  fi
}

main
