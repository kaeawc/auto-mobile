#!/usr/bin/env bash
#
# Backward-compatible entry point for the canonical fast unit lane. Worker
# selection and OS-specific behavior live in scripts/test-ts.sh.
set -euo pipefail

if [ "${TEST_FAST_PRINT_CMD:-}" = "1" ]; then
  export TEST_TS_PRINT_CMD=1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$ROOT/scripts/test-ts.sh" unit "$@"
