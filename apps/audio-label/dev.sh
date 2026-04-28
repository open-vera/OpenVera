#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/gui"
exec npm run tauri dev
