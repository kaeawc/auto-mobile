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

# shellcheck source=scripts/lib/shell-core.sh disable=SC1091
source "${PROJECT_ROOT}/scripts/lib/shell-core.sh"
ensure_node_modules "${PROJECT_ROOT}"

echo "Worktree bootstrap complete."
