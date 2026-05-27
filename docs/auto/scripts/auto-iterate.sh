#!/bin/bash
# auto-iterate.sh - 自动化迭代闭环
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REPORT_DIR="$PROJECT_ROOT/docs/auto/reports"
MAX_ITERATIONS=5
TARGET_SCORE=0.9

mkdir -p "$REPORT_DIR"

# 检查参数
if [ -z "$1" ]; then
  echo "用法: $0 <task-id>"
  echo "例如: $0 S1"
  exit 1
fi

TASK_ID="$1"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
REPORT_FILE="$REPORT_DIR/iterate-${TASK_ID}-${TIMESTAMP}.md"

# 初始化报告
init_report() {
  cat > "$REPORT_FILE" << EOF
# 自动迭代报告: $TASK_ID

- 开始时间: $(date)
- 最大迭代次数: $MAX_ITERATIONS
- 目标评分: $TARGET_SCORE

## 迭代记录

EOF
}

# 运行 Critique
run_critique() {
  local iteration=$1
  
  echo "🔍 [Iteration $iteration] 运行 Critique..."
  
  # 这里需要集成 Vera 的 Critique 能力
  # 示例实现：调用 critique.sh 脚本
  if [ -f "$SCRIPT_DIR/critique.sh" ]; then
    critique_output=$("$SCRIPT_DIR/critique.sh" "$TASK_ID" 2>&1)
  else
    # 简化实现：使用 LLM API 进行 critique
    echo "⚠️  Critique 功能待实现，使用模拟数据"
    critique_output='{"score": 0.7, "confidence": 0.8, "nextAction": "replan"}'
  fi
  
  echo "$critique_output"
}

# 解析 Critique 结果
parse_critique() {
  local critique_json=$1
  
  # 提取评分（简化版，实际需要 jq 解析 JSON）
  score=$(echo "$critique_json" | grep -oE '"score":\s*[0-9]+\.[0-9]+' | grep -oE '[0-9]+\.[0-9]+')
  next_action=$(echo "$critique_json" | grep -oE '"nextAction":\s*"[a-z_]+"' | grep -oE '"[a-z_]+"' | tr -d '"')
  
  echo "$score|$next_action"
}

# 执行 Replan
run_replan() {
  local iteration=$1
  local issues=$2
  
  echo "📋 [Iteration $iteration] 执行 Replan..."
  
  # 调用 auto-dev.sh 进行修复
  if [ -f "$SCRIPT_DIR/auto-dev.sh" ]; then
    "$SCRIPT_DIR/auto-dev.sh" "$TASK_ID"
  else
    echo "⚠️  Replan 功能待实现"
  fi
}

# 运行测试验证
run_tests() {
  echo "🧪 运行测试验证..."
  
  if pnpm run test; then
    echo "✅ 测试通过"
    return 0
  else
    echo "❌ 测试失败"
    return 1
  fi
}

# 主迭代循环
iterate() {
  local iteration=1
  
  while [ $iteration -le $MAX_ITERATIONS ]; do
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🔄 Iteration $iteration / $MAX_ITERATIONS"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    
    # 1. 运行 Critique
    critique_result=$(run_critique $iteration)
    parsed=$(parse_critique "$critique_result")
    score=$(echo "$parsed" | cut -d'|' -f1)
    next_action=$(echo "$parsed" | cut -d'|' -f2)
    
    # 记录到报告
    cat >> "$REPORT_FILE" << EOF
### Iteration $iteration
- 评分: $score
- 下一步: $next_action

EOF
    
    echo "📊 评分: $score"
    echo "🎯 下一步: $next_action"
    
    # 2. 检查是否达标
    if (( $(echo "$score >= $TARGET_SCORE" | bc -l 2>/dev/null || echo "0") )); then
      echo ""
      echo "✅ 达标！评分 $score >= $TARGET_SCORE"
      
      # 记录完成
      cat >> "$REPORT_FILE" << EOF

## 结果
- 状态: ✅ 完成
- 最终评分: $score
- 迭代次数: $iteration
- 结束时间: $(date)
EOF
      
      return 0
    fi
    
    # 3. 执行 Replan
    if [ "$next_action" = "replan" ]; then
      run_replan $iteration "$critique_result"
    elif [ "$next_action" = "complete" ]; then
      echo "✅ Critique 建议完成"
      
      cat >> "$REPORT_FILE" << EOF

## 结果
- 状态: ✅ 完成（Critique 建议）
- 最终评分: $score
- 迭代次数: $iteration
- 结束时间: $(date)
EOF
      
      return 0
    elif [ "$next_action" = "ask_human" ]; then
      echo "⚠️  需要人工介入"
      
      cat >> "$REPORT_FILE" << EOF

## 结果
- 状态: ⚠️ 需要人工介入
- 最终评分: $score
- 迭代次数: $iteration
- 结束时间: $(date)
EOF
      
      return 1
    fi
    
    # 4. 运行测试验证
    if ! run_tests; then
      echo "❌ 测试失败，继续迭代..."
    fi
    
    iteration=$((iteration + 1))
  done
  
  # 达到最大迭代次数
  echo ""
  echo "⚠️  达到最大迭代次数 ($MAX_ITERATIONS)"
  
  cat >> "$REPORT_FILE" << EOF

## 结果
- 状态: ⚠️ 达到最大迭代次数
- 最终评分: $score
- 迭代次数: $MAX_ITERATIONS
- 结束时间: $(date)
EOF
  
  return 1
}

# 主流程
main() {
  cd "$PROJECT_ROOT"
  
  echo "=== 自动化迭代: $TASK_ID ==="
  echo "目标评分: $TARGET_SCORE"
  echo "最大迭代次数: $MAX_ITERATIONS"
  echo ""
  
  # 初始化报告
  init_report
  
  # 运行迭代
  if iterate; then
    echo ""
    echo "📄 详细报告: $REPORT_FILE"
    echo "✅ 迭代完成！"
    exit 0
  else
    echo ""
    echo "📄 详细报告: $REPORT_FILE"
    echo "❌ 迭代未达标，请人工检查"
    exit 1
  fi
}

main
