#!/usr/bin/env bash
# 打包脚本：版本自增 + Tauri 正式构建
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERSION_FILE="$SCRIPT_DIR/VERSION"

# ── 读取当前版本 ──
if [ ! -f "$VERSION_FILE" ]; then
  echo "0.1.0" > "$VERSION_FILE"
fi
CURRENT=$(cat "$VERSION_FILE" | tr -d '[:space:]')
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

echo ""
echo "  Audio Label 打包工具"
echo "  当前版本: $CURRENT"
echo ""

# ── 选择版本升级类型 ──
echo "  选择版本升级方式："
echo "    1) patch  $MAJOR.$MINOR.$((PATCH + 1))  （默认，小版本修复）"
echo "    2) minor  $MAJOR.$((MINOR + 1)).0  （功能更新）"
echo "    3) major  $((MAJOR + 1)).0.0  （大版本）"
echo "    4) 不升级，保持 $CURRENT"
echo ""
read -r -p "  请选择 [1/2/3/4] (默认 1): " CHOICE

case "${CHOICE:-1}" in
  1) PATCH=$((PATCH + 1)) ;;
  2) MINOR=$((MINOR + 1)); PATCH=0 ;;
  3) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  4) ;;
  *) echo "无效选择"; exit 1 ;;
esac

NEW_VERSION="$MAJOR.$MINOR.$PATCH"
echo ""
echo "  → 版本: $NEW_VERSION"

# ── 写入版本号到各文件 ──
echo "$NEW_VERSION" > "$VERSION_FILE"

# pyproject.toml
sed -i '' "s/^version = \".*\"/version = \"$NEW_VERSION\"/" "$SCRIPT_DIR/pyproject.toml"

# gui/package.json
sed -i '' "s/\"version\": \".*\"/\"version\": \"$NEW_VERSION\"/" "$SCRIPT_DIR/gui/package.json"

# gui/src-tauri/tauri.conf.json
sed -i '' "s/\"version\": \".*\"/\"version\": \"$NEW_VERSION\"/" "$SCRIPT_DIR/gui/src-tauri/tauri.conf.json"

# src/audio_label/__init__.py
sed -i '' "s/__version__ = \".*\"/__version__ = \"$NEW_VERSION\"/" "$SCRIPT_DIR/src/audio_label/__init__.py"

# gui/src-tauri/Cargo.toml
sed -i '' "s/^version = \".*\"/version = \"$NEW_VERSION\"/" "$SCRIPT_DIR/gui/src-tauri/Cargo.toml"

echo "  ✓ 版本号已更新到 $NEW_VERSION"
echo ""

# ── 构建 ──
echo "  [1/3] 构建 Python 二进制 (PyInstaller)..."
bash "$SCRIPT_DIR/scripts/build-python.sh"

echo ""
echo "  [2/3] 构建前端..."
cd "$SCRIPT_DIR/gui"
npm run build

echo ""
echo "  [3/3] 构建 Tauri 应用 (release)..."
npm run tauri build 2>&1

echo ""
echo "  ✓ 构建完成！"
echo ""

# ── 输出结果 ──
BUNDLE_DIR="$SCRIPT_DIR/gui/src-tauri/target/release/bundle"
echo "  输出目录: $BUNDLE_DIR"
echo ""

if [ -d "$BUNDLE_DIR/dmg" ]; then
  echo "  DMG 安装包："
  ls -lh "$BUNDLE_DIR/dmg/"*.dmg 2>/dev/null | awk '{print "    " $NF " (" $5 ")"}'
fi

if [ -d "$BUNDLE_DIR/macos" ]; then
  echo ""
  echo "  macOS App："
  du -sh "$BUNDLE_DIR/macos/"*.app 2>/dev/null | awk '{print "    " $2 " (" $1 ")"}'
fi

echo ""
echo "  版本: $NEW_VERSION"
echo "  完成！"
