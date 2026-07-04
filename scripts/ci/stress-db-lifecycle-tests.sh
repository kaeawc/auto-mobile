#!/usr/bin/env bash
#
# Reliability gate for the file-backed DB lifecycle suites that flake on
# windows-latest (issue #2992): they open a real temp DB, run migrations on a
# separate connection, then close/reopen. On Windows the app-connection WAL
# checkpoint contends with the still-running detached migration connection,
# producing timeout-shaped failures that rotate between suites run-to-run.
#
# This script runs the two suites repeatedly and fails on the FIRST failing
# iteration, so a flake that only shows up occasionally is far likelier to be
# caught locally (and in CI) than a single `bun test` pass. It is the
# reproducible stand-in for "pass reliably across repeated runs" from the
# issue's acceptance criteria; it cannot literally reproduce Windows handle
# semantics on macOS/Linux, but it does exercise the exact open/migrate/
# close/reopen ordering the fix stabilizes.
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
  "test/db/databaseLazyPath.test.ts"
  "test/db/dbWriteBarrierResetOnClose.test.ts"
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
