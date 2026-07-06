#!/usr/bin/env bash
#
# Cheap Codex/worktree bootstrap. Keep this limited to fast repo-local setup;
# do not install Android, Gradle, Xcode, Homebrew, or platform toolchains here.
#
# Usage:
#   bash scripts/codex/bootstrap-worktree.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

cd "${PROJECT_ROOT}"
mkdir -p scratch

if [[ ! -d node_modules || ! -x node_modules/.bin/turbo ]]; then
  echo "Installing Bun dependencies from bun.lock..."
  bun install --frozen-lockfile
else
  echo "Bun dependencies already installed."
fi

echo "Worktree bootstrap complete."
