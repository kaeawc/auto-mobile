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

if [[ ! -d "$PROJECT_ROOT/android" ]]; then
  echo "Unable to scan Android sources under $PROJECT_ROOT/android." >&2
  exit 1
fi

if matches="$(rg --fixed-strings --line-number -- "$UNIFIED_PACKAGE" "$PROJECT_ROOT/android")"; then
  echo "desktop-core still references the deleted core.unified package:" >&2
  echo "$matches" >&2
  exit 1
else
  status=$?
  if [[ "$status" -ne 1 ]]; then
    echo "Unable to scan Android sources under $PROJECT_ROOT/android." >&2
    exit "$status"
  fi
fi

echo "No desktop-core unified socket-client package or references found."
