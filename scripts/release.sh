#!/usr/bin/env bash
set -e

CORE_PKG="packages/core/package.json"
OPENVERA_PKG="packages/harness/package.json"

current_core=$(node -p "require('./$CORE_PKG').version")
current_openvera=$(node -p "require('./$OPENVERA_PKG').version")

echo ""
echo "Current versions:"
echo "  @open-vera/core     $current_core"
echo "  @open-vera/openvera $current_openvera"
echo ""
echo "Select release type:"
echo "  1) patch  (bug fixes)"
echo "  2) minor  (new features, backwards-compatible)"
echo "  3) major  (breaking changes)"
echo ""
read -r -p "Choice [1/2/3]: " choice

case "$choice" in
  1) bump="patch" ;;
  2) bump="minor" ;;
  3) bump="major" ;;
  *)
    echo "Cancelled."
    exit 1
    ;;
esac

bump_version() {
  local ver="$1"
  local type="$2"
  IFS='.' read -r major minor patch <<< "$ver"
  case "$type" in
    patch) patch=$((patch + 1)) ;;
    minor) minor=$((minor + 1)); patch=0 ;;
    major) major=$((major + 1)); minor=0; patch=0 ;;
  esac
  echo "$major.$minor.$patch"
}

new_version=$(bump_version "$current_core" "$bump")

echo ""
echo "Will release: $current_core → $new_version ($bump)"
read -r -p "Confirm? [y/N]: " confirm
[[ "$confirm" =~ ^[Yy]$ ]] || { echo "Cancelled."; exit 1; }

# Bump versions in package.json files
node -e "
  const fs = require('fs');
  ['$CORE_PKG', '$OPENVERA_PKG'].forEach(f => {
    const pkg = JSON.parse(fs.readFileSync(f, 'utf8'));
    pkg.version = '$new_version';
    fs.writeFileSync(f, JSON.stringify(pkg, null, 2) + '\n');
    console.log('Bumped', pkg.name, 'to', pkg.version);
  });
"

echo ""
echo "Building and publishing..."
pnpm --filter @open-vera/core run release
pnpm --filter @open-vera/openvera run release

echo ""
echo "Released $new_version successfully."
