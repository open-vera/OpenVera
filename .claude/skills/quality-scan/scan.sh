#!/usr/bin/env bash
# Parallel quality scan: oxlint + ESLint/sonarjs + jscpd
# Usage: bash scan.sh [target_dir] [--verbose]
set -uo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SKILL_DIR/../../.." && pwd)"
TARGET="${1:-packages}"
VERBOSE="${2:-}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

cd "$ROOT_DIR"

mkdir -p "$TMP/jscpd"

echo "▶ 扫描目标: $TARGET"
echo "▶ 工作目录: $ROOT_DIR"
echo ""

# ── oxlint ──────────────────────────────────────────────────────────────────
pnpm exec oxlint \
  --config "$SKILL_DIR/oxlint.config.json" \
  --format json \
  "$TARGET" \
  > "$TMP/oxlint.json" 2>"$TMP/oxlint.err" &
P_OXLINT=$!

# ── ESLint + sonarjs（无类型检查）─────────────────────────────────────────
pnpm exec eslint \
  --config "$SKILL_DIR/eslint.sonarjs.config.js" \
  --format json \
  "$TARGET" \
  > "$TMP/sonarjs.json" 2>"$TMP/sonarjs.err" &
P_SONARJS=$!

# ── jscpd ────────────────────────────────────────────────────────────────────
pnpm exec jscpd \
  "$TARGET" \
  --min-tokens 50 \
  --reporters json \
  --output "$TMP/jscpd" \
  --ignore "**/*.d.ts,**/dist/**,**/build/**,**/node_modules/**,**/coverage/**" \
  --silent \
  > "$TMP/jscpd.log" 2>&1 &
P_JSCPD=$!

# ── 等待全部完成 ─────────────────────────────────────────────────────────────
wait $P_OXLINT;  E_OXLINT=$?
wait $P_SONARJS; E_SONARJS=$?
wait $P_JSCPD;   E_JSCPD=$?

# ── 输出结果（stdout 供 Claude 解析）────────────────────────────────────────
echo "=== OXLINT_JSON_BEGIN ==="
cat "$TMP/oxlint.json" 2>/dev/null || echo "[]"
echo ""
echo "=== OXLINT_JSON_END ==="

echo "=== SONARJS_JSON_BEGIN ==="
cat "$TMP/sonarjs.json" 2>/dev/null || echo "[]"
echo ""
echo "=== SONARJS_JSON_END ==="

echo "=== JSCPD_JSON_BEGIN ==="
cat "$TMP/jscpd/jscpd-report.json" 2>/dev/null || echo "{}"
echo ""
echo "=== JSCPD_JSON_END ==="

# stderr 详情（verbose 时打印）
if [ -n "$VERBOSE" ]; then
  echo ""
  echo "=== STDERR: oxlint ==="
  cat "$TMP/oxlint.err" 2>/dev/null || true
  echo "=== STDERR: sonarjs ==="
  cat "$TMP/sonarjs.err" 2>/dev/null || true
  echo "=== STDERR: jscpd ==="
  cat "$TMP/jscpd.log" 2>/dev/null || true
fi

# 三工具只要任一有 error 级别发现就返回非零（不阻断，由 SKILL.md 决策）
exit 0
