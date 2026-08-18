#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Optional first argument overrides the scanned root. Tests use this to point
# the guard at a temp fixture tree instead of mutating the real repository,
# which raced sibling tests under `bats --jobs` (fixture visible to the
# "passes when absent" tests running concurrently).
PROJECT_ROOT="${1:-$(cd "$SCRIPT_DIR/../.." && pwd)}"

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

# Layered scanner: rg when available (fastest, works in jj workspaces with no
# Git worktree — the reason #5386 reached for it), then `git grep` inside a Git
# worktree (the deliberate no-ripgrep CI path from 6f2434a40 — merge.yml's BATS
# runners do not ship rg, so an unconditional rg dependency 127s there), then
# plain `grep -rF` as the last resort (jj workspace on a host without rg).
# All three exit 0=match, 1=no-match, >1=error, so the caller logic is shared.
scan_for_unified_references() {
  if command -v rg > /dev/null 2>&1; then
    rg --fixed-strings --line-number -- "$UNIFIED_PACKAGE" "$PROJECT_ROOT/android"
  elif git -C "$PROJECT_ROOT" rev-parse --is-inside-work-tree > /dev/null 2>&1; then
    git -C "$PROJECT_ROOT" grep --untracked --fixed-strings --line-number "$UNIFIED_PACKAGE" -- android
  else
    grep -rFn -- "$UNIFIED_PACKAGE" "$PROJECT_ROOT/android"
  fi
}

if matches="$(scan_for_unified_references)"; then
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
