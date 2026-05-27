#!/bin/bash
# auto-iterate-batch.sh - 批量迭代（整个 Phase）
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ROADMAP="$PROJECT_ROOT/P1-IMPLEMENTATION-PLAN.md"
REPORT_DIR="$PROJECT_ROOT/docs/auto/reports"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
SUMMARY_REPORT="$REPORT_DIR/phase-iterate-summary-${TIMESTAMP}.md"

mkdir -p "$REPORT_DIR"

# 检查参数
if [ -z "$1" ]; then
  echo "用法: $0 <phase-number>"
  echo "例如: $0 1"
  exit 1
fi

PHASE_NUM="$1"

# 初始化汇总报告
init_summary() {
  cat > "$SUMMARY_REPORT" << EOF
# Phase $PHASE_NUM 迭代汇总

- 开始时间: $(date)
- 目标: 自动迭代所有任务直到达标

## 任务结果

EOF
}

# 提取指定 Phase 的任务
extract_phase_tasks() {
  local phase_num=$1
  
  phase_start=$(grep -n "^## Phase ${phase_num}:" "$ROADMAP" | head -1 | cut -d: -f1)
  
  if [ -z "$phase_start" ]; then
    echo "❌ 找不到 Phase $phase_num"
    exit 1
  fi
  
  phase_end=$(tail -n +$((phase_start + 1)) "$ROADMAP" | grep -n "^## Phase" | head -1 | cut -d: -f1)
  
  if [ -z "$phase_end" ]; then
    phase_end=$(wc -l < "$ROADMAP")
  else
    phase_end=$((phase_start + phase_end - 1))
  fi
  
  sed -n "${phase_start},${phase_end}p" "$ROADMAP" | \
    grep "^\- \[ \]" | \
    grep -oE '\*\*[A-Z]+[0-9]+\*\*' | \
    sed 's/\*\*//g'
}

# 主流程
main() {
  cd "$PROJECT_ROOT"
  
  echo "=== 批量迭代: Phase $PHASE_NUM ==="
  echo ""
  
  # 初始化汇总报告
  init_summary
  
  # 提取任务列表
  tasks=$(extract_phase_tasks "$PHASE_NUM")
  
  if [ -z "$tasks" ]; then
    echo "✅ Phase $PHASE_NUM 没有待完成任务"
    exit 0
  fi
  
  echo "待迭代任务:"
  echo "$tasks" | while read -r task_id; do
    echo "  - $task_id"
  done
  echo ""
  
  # 串行处理每个任务
  total=0
  success=0
  failed=0
  
  echo "$tasks" | while read -r task_id; do
    total=$((total + 1))
    
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🔄 迭代任务: $task_id"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    
    if "$SCRIPT_DIR/auto-iterate.sh" "$task_id"; then
      echo "✅ 任务 $task_id 迭代成功"
      success=$((success + 1))
      
      # 记录到汇总报告
      echo "- [x] $task_id - 成功" >> "$SUMMARY_REPORT"
    else
      echo "❌ 任务 $task_id 迭代失败"
      failed=$((failed + 1))
      
      # 记录到汇总报告
      echo "- [ ] $task_id - 失败" >> "$SUMMARY_REPORT"
    fi
  done
  
  # 汇总结果
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "📊 批量迭代完成"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "总计: $total"
  echo "成功: $success"
  echo "失败: $failed"
  echo ""
  echo "📄 汇总报告: $SUMMARY_REPORT"
  
  # 记录汇总信息
  cat >> "$SUMMARY_REPORT" << EOF

## 统计

- 总计: $total
- 成功: $success
- 失败: $failed
- 结束时间: $(date)
EOF
}

main
