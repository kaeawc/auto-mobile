#!/usr/bin/env bash
set -euo pipefail

# Prevent newly added production callers from bypassing SimCtlClient. Existing
# migration debt is intentionally not treated as a failure here: this check is
# a ratchet, while issue #4049 migrates callers incrementally. The row lives in
# scripts/lib/boundaryRows.ts.
# shellcheck disable=SC1091 # Resolved relative to this script's location.
source "$(dirname "${BASH_SOURCE[0]}")/lib/boundary-row.sh"
run_boundary_row simctl simctl 1 "${1:-origin/main}"
