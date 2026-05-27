#!/bin/bash
# auto-rollback.sh - 自动回滚
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REPORT_DIR="$PROJECT_ROOT/docs/auto/reports"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
FAILURE_REPORT="$REPORT_DIR/test-failure-${TIMESTAMP}.md"

mkdir -p "$REPORT_DIR"

# 检查是否有未提交的更改
check_changes() {
  if git diff --quiet && git diff --cached --quiet; then
    echo "✅ 没有未提交的更改"
    return 0
  else
    echo "⚠️  有未提交的更改"
    return 1
  fi
}

# 保存失败日志
save_failure_log() {
  local error_output=$1
  
  cat > "$FAILURE_REPORT" << EOF
# 测试失败报告

- 时间: $(date)
- 分支: $(git branch --show-current)
- Commit: $(git rev-parse HEAD)

## 错误输出

\`\`\`
$error_output
\`\`\`

## Git 状态

\`\`\`
$(git status)
\`\`\`

## 最近提交

\`\`\`
$(git log --oneline -5)
\`\`\`
EOF
  
  echo "📄 失败报告已保存: $FAILURE_REPORT"
}

# 回滚到上一个 commit
rollback() {
  echo "🔄 回滚到上一个 commit..."
  
  # 保存当前 commit 信息
  current_commit=$(git rev-parse HEAD)
  commit_message=$(git log -1 --pretty=%B)
  
  # 回滚
  git reset --hard HEAD~1
  
  echo "✅ 回滚完成"
  echo "  原 commit: $current_commit"
  echo "  原消息: $commit_message"
  echo ""
  echo "如需恢复，运行: git cherry-pick $current_commit"
}

# 主流程
main() {
  cd "$PROJECT_ROOT"
  
  echo "=== 自动回滚 ==="
  echo ""
  
  # 检查是否有更改
  if check_changes; then
    echo "没有需要回滚的更改"
    exit 0
  fi
  
  # 运行测试
  echo "🧪 运行测试..."
  test_output=$(pnpm run test 2>&1) || {
    # 测试失败，保存日志并回滚
    save_failure_log "$test_output"
    rollback
    exit 0
  }
  
  echo "✅ 测试通过，无需回滚"
}

main
