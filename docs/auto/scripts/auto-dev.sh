#!/bin/bash
# auto-dev.sh - 自动化开发单个任务
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ROADMAP="$PROJECT_ROOT/P1-IMPLEMENTATION-PLAN.md"

# 检查参数
if [ -z "$1" ]; then
  echo "用法: $0 <task-id>"
  echo "例如: $0 S1"
  echo ""
  echo "可用任务:"
  "$SCRIPT_DIR/extract-tasks.sh"
  exit 1
fi

TASK_ID="$1"

# 从 roadmap 提取任务信息
extract_task_info() {
  local task_id=$1
  
  # 查找任务行
  task_line=$(grep -n "\*\*${task_id}\*\*" "$ROADMAP" | head -1)
  
  if [ -z "$task_line" ]; then
    echo "❌ 找不到任务: $task_id"
    exit 1
  fi
  
  line_num=$(echo "$task_line" | cut -d: -f1)
  task_content=$(echo "$task_line" | cut -d: -f2-)
  
  # 提取 Phase
  phase=$(head -n "$line_num" "$ROADMAP" | grep -E "^## Phase" | tail -1 | sed 's/## //')
  
  # 提取描述
  description=$(echo "$task_content" | sed 's/^- \[ \] \*\*[A-Z]*[0-9]*\*\* //')
  
  echo "$phase|$description"
}

# 创建分支
create_branch() {
  local task_id=$1
  local branch_name="auto/${task_id}"
  
  echo "🌿 创建分支: $branch_name"
  git checkout -b "$branch_name"
}

# 使用 LLM 生成代码
generate_code() {
  local task_id=$1
  local description=$2
  
  echo "🤖 使用 LLM 生成代码..."
  echo "任务: $description"
  echo ""
  
  # 这里可以集成 LLM API
  # 示例：调用 Claude API 生成代码骨架
  # 实际实现需要根据项目配置调整
  
  echo "⚠️  LLM 代码生成功能待实现"
  echo "请手动实现任务: $task_id"
}

# 运行测试
run_tests() {
  echo "🧪 运行测试..."
  
  # 运行相关测试
  if pnpm run test; then
    echo "✅ 测试通过"
    return 0
  else
    echo "❌ 测试失败"
    return 1
  fi
}

# 提交代码
commit_changes() {
  local task_id=$1
  local description=$2
  
  echo "📝 提交代码..."
  
  git add .
  git commit -m "feat(${task_id}): ${description}"
  
  echo "✅ 提交完成"
}

# 创建 PR
create_pr() {
  local task_id=$1
  local description=$2
  
  echo "📤 创建 Pull Request..."
  
  # 推送分支
  git push origin "auto/${task_id}"
  
  # 创建 PR（需要 gh CLI）
  if command -v gh &> /dev/null; then
    gh pr create \
      --title "feat(${task_id}): ${description}" \
      --body "自动开发任务: ${task_id}\n\n${description}" \
      --base main
    echo "✅ PR 创建成功"
  else
    echo "⚠️  gh CLI 未安装，请手动创建 PR"
  fi
}

# 主流程
main() {
  cd "$PROJECT_ROOT"
  
  echo "=== 自动化开发: $TASK_ID ==="
  echo ""
  
  # 1. 提取任务信息
  task_info=$(extract_task_info "$TASK_ID")
  phase=$(echo "$task_info" | cut -d'|' -f1)
  description=$(echo "$task_info" | cut -d'|' -f2)
  
  echo "Phase: $phase"
  echo "任务: $description"
  echo ""
  
  # 2. 创建分支
  create_branch "$TASK_ID"
  
  # 3. 生成代码
  generate_code "$TASK_ID" "$description"
  
  # 4. 运行测试
  if run_tests; then
    # 5. 提交代码
    commit_changes "$TASK_ID" "$description"
    
    # 6. 创建 PR
    create_pr "$TASK_ID" "$description"
    
    echo ""
    echo "✅ 任务 $TASK_ID 开发完成！"
  else
    echo ""
    echo "❌ 任务 $TASK_ID 开发失败，请检查测试错误"
    exit 1
  fi
}

main
