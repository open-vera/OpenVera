#!/bin/bash
# run-tests.sh - 自动化测试运行器
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REPORT_DIR="$PROJECT_ROOT/docs/auto/reports"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

mkdir -p "$REPORT_DIR"

# 解析参数
CHANGED_ONLY=false
WATCH_MODE=false

for arg in "$@"; do
  case $arg in
    --changed)
      CHANGED_ONLY=true
      ;;
    --watch)
      WATCH_MODE=true
      ;;
  esac
done

# 运行测试并生成覆盖率报告
run_tests() {
  local package=$1
  local report_file="$REPORT_DIR/test-report-${TIMESTAMP}.md"
  
  echo "=== 测试报告 ===" > "$report_file"
  echo "时间: $(date)" >> "$report_file"
  echo "" >> "$report_file"
  
  if [ "$CHANGED_ONLY" = true ]; then
    echo "模式: 增量测试（仅改动文件）" >> "$report_file"
  else
    echo "模式: 全量测试" >> "$report_file"
  fi
  
  echo "" >> "$report_file"
  echo "## 结果" >> "$report_file"
  echo "" >> "$report_file"
  
  # 运行测试
  if [ -n "$package" ]; then
    echo "📦 测试 $package..."
    pnpm --filter "$package" run test:coverage 2>&1 | tee -a "$report_file"
  else
    echo "📦 测试所有包..."
    pnpm run test 2>&1 | tee -a "$report_file"
  fi
  
  echo ""
  echo "报告已保存: $report_file"
}

# 检查覆盖率
check_coverage() {
  local package=$1
  local threshold=90
  
  echo "=== 覆盖率检查 ==="
  
  # 运行覆盖率测试
  coverage_output=$(pnpm --filter "$package" run test:coverage 2>&1)
  
  # 提取覆盖率（简化版，实际需要解析 vitest 输出）
  if echo "$coverage_output" | grep -q "Lines.*%"; then
    coverage=$(echo "$coverage_output" | grep -oE "Lines.*[0-9]+\.[0-9]+%" | grep -oE "[0-9]+\.[0-9]+")
    
    if (( $(echo "$coverage >= $threshold" | bc -l) )); then
      echo "✅ $package: ${coverage}% (threshold: ${threshold}%)"
      return 0
    else
      echo "❌ $package: ${coverage}% (threshold: ${threshold}%)"
      return 1
    fi
  else
    echo "⚠️  无法解析 $package 的覆盖率"
    return 1
  fi
}

# 主流程
main() {
  cd "$PROJECT_ROOT"
  
  if [ "$WATCH_MODE" = true ]; then
    echo "👀 监控模式启动..."
    echo "文件变更时自动运行测试"
    echo "按 Ctrl+C 退出"
    echo ""
    
    # 使用 fswatch 或 inotifywait 监控文件变更
    if command -v fswatch &> /dev/null; then
      fswatch -o packages/ | while read; do
        echo ""
        echo "🔄 检测到变更，运行测试..."
        run_tests
      done
    else
      echo "❌ 需要安装 fswatch: brew install fswatch"
      exit 1
    fi
  else
    run_tests "$@"
  fi
}

main "$@"
