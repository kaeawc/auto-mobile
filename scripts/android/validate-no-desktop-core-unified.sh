#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

readonly UNIFIED_DIR="$PROJECT_ROOT/android/desktop-core/src/main/kotlin/dev/jasonpearson/automobile/desktop/core/unified"
readonly UNIFIED_PACKAGE="dev.jasonpearson.automobile.desktop.core.unified"

if [[ -d "$UNIFIED_DIR" ]]; then
  echo "desktop-core unified socket-client package still exists: $UNIFIED_DIR" >&2
  exit 1
fi

if ! rg --files "$PROJECT_ROOT/android" >/dev/null; then
  echo "Unable to scan Android sources under $PROJECT_ROOT/android." >&2
  exit 1
fi

if rg --fixed-strings --quiet "$UNIFIED_PACKAGE" "$PROJECT_ROOT/android"; then
  echo "desktop-core still references the deleted core.unified package:" >&2
  rg --fixed-strings --line-number "$UNIFIED_PACKAGE" "$PROJECT_ROOT/android" >&2
  exit 1
fi

echo "No desktop-core unified socket-client package or references found."
