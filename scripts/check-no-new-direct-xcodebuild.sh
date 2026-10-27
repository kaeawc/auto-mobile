#!/usr/bin/env bash
set -euo pipefail

# Keep production xcodebuild execution behind XcodebuildClient. This is a
# diff-based ratchet: scripts and tests intentionally remain diagnostic tools.
# The row lives in scripts/lib/boundaryRows.ts.
# shellcheck source=scripts/lib/boundary-row.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/boundary-row.sh"
run_boundary_row xcodebuild xcodebuild 0 "${1:-origin/main}"
