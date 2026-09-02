#!/usr/bin/env bash
#
# LOCAL ordering-soak for the file-backed DB lifecycle suites that flaked on
# windows-latest (issue #2992): they open a real temp DB, run migrations on a
# separate connection, then close/reopen. On Windows the app-connection WAL
# checkpoint contended with the still-running detached migration connection,
# producing timeout-shaped failures that rotated between suites run-to-run.
#
# This runs the two suites repeatedly and fails on the FIRST failing iteration.
# It is NOT wired into any CI workflow and it CANNOT reproduce the Windows
# handle/WAL semantics on macOS/Linux — so a green run here is not proof the
# Windows flake is gone. What it DOES give you locally is repeated exercise of
# the exact open/migrate/close/reopen ordering the fix stabilizes, catching an
# ordering regression that a single `bun test` pass could miss. Treat it as a
# developer aid, not a gate.
#
# Usage: scripts/ci/stress-db-lifecycle-tests.sh [iterations]
#   iterations defaults to 20; override for a longer soak.

set -euo pipefail

export PATH="${HOME}/.bun/bin:${PATH}"

iterations="${1:-20}"

if ! [[ "$iterations" =~ ^[0-9]+$ ]] || [[ "$iterations" -lt 1 ]]; then
  echo "error: iterations must be a positive integer (got '${iterations}')" >&2
  exit 2
fi

suites=(
  "test/db/databaseLazyPath.integration.test.ts"
  "test/db/dbWriteBarrierResetOnClose.integration.test.ts"
)

echo "Stressing DB lifecycle suites ${iterations}x: ${suites[*]}"

for ((i = 1; i <= iterations; i++)); do
  echo "--- iteration ${i}/${iterations} ---"
  if ! bun test "${suites[@]}"; then
    echo "error: DB lifecycle suite failed on iteration ${i}/${iterations}" >&2
    exit 1
  fi
done

echo "OK: ${iterations} iterations passed with no DB lifecycle flake"
