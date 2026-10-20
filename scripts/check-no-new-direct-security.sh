#!/usr/bin/env bash
set -euo pipefail

# Keep macOS security execution in SecurityClient. This is a diff ratchet: it
# permits no production exceptions because doctor and Xcode signing both use
# the same injected client. The row lives in scripts/lib/boundaryRows.ts.
# shellcheck source=scripts/lib/boundary-row.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/boundary-row.sh"
run_boundary_row security security 1 "${1:-origin/main}"
