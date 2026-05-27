#!/bin/bash
# critique.sh - 运行 Critique 评估
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# 检查参数
if [ -z "$1" ]; then
  echo "用法: $0 <task-id>"
  echo "例如: $0 S1"
  exit 1
fi

TASK_ID="$1"

# 从 roadmap 提取任务信息
extract_task_info() {
  local roadmap="$PROJECT_ROOT/P1-IMPLEMENTATION-PLAN.md"
  local task_id=$1
  
  task_line=$(grep -n "\*\*${task_id}\*\*" "$roadmap" | head -1)
  
  if [ -z "$task_line" ]; then
    echo "❌ 找不到任务: $task_id"
    exit 1
  fi
  
  line_num=$(echo "$task_line" | cut -d: -f1)
  task_content=$(echo "$task_line" | cut -d: -f2-)
  
  # 提取描述
  description=$(echo "$task_content" | sed 's/^- \[ \] \*\*[A-Z]*[0-9]*\*\* //')
  
  echo "$description"
}

# 查找相关代码文件
find_related_files() {
  local task_id=$1
  
  # 根据任务 ID 推断相关文件
  # 这里需要根据项目结构调整
  case $task_id in
    S*)
      # Self-loop 相关
      find packages/harness/src/flow -name "*.ts" 2>/dev/null || echo ""
      ;;
    CR*)
      # Critic 相关
      find packages/harness/src/critic -name "*.ts" 2>/dev/null || echo ""
      ;;
    T*)
      # Tool 相关
      find packages/core/src -name "*.ts" -path "*tool*" 2>/dev/null || echo ""
      ;;
    *)
      echo ""
      ;;
  esac
}

# 运行 Critique（简化版）
# 实际实现需要调用 LLM API
run_critique() {
  local task_id=$1
  local description=$2
  local files=$3
  
  echo "=== Critique: $task_id ==="
  echo ""
  echo "任务描述:"
  echo "$description"
  echo ""
  echo "相关文件:"
  echo "$files"
  echo ""
  
  # 这里应该调用 LLM API 进行 critique
  # 示例输出（模拟）
  cat << EOF
{
  "score": 0.75,
  "confidence": 0.85,
  "issues": [
    {
      "severity": "major",
      "category": "test_coverage",
      "description": "缺少并发场景测试",
      "suggestedFix": "补充多线程并发测试用例"
    },
    {
      "severity": "minor",
      "category": "maintainability",
      "description": "魔法数字应提取为常量",
      "suggestedFix": "提取 DEFAULT_MAX_CYCLES 等常量"
    }
  ],
  "nextAction": "replan"
}
EOF
}

# 主流程
main() {
  cd "$PROJECT_ROOT"
  
  echo "🔍 运行 Critique: $TASK_ID"
  echo ""
  
  # 1. 提取任务信息
  description=$(extract_task_info "$TASK_ID")
  
  # 2. 查找相关文件
  files=$(find_related_files "$TASK_ID")
  
  # 3. 运行 Critique
  run_critique "$TASK_ID" "$description" "$files"
}

main
