#!/usr/bin/env bash
#
# Run TypeScript tests with Bun coverage and tolerate Bun's WriteFailed bug only
# when tests completed successfully.
#
# Usage:
#   scripts/ci/run-ts-coverage.sh [log-file]

set -euo pipefail

log_file="${1:-ci-logs/ts-coverage.log}"
mkdir -p "$(dirname "${log_file}")"

set +e
bun test --coverage --coverage-reporter=lcov --coverage-dir=coverage 2>&1 | tee "${log_file}"
status=${PIPESTATUS[0]}
set -e

if [[ "${status}" -eq 0 ]]; then
  exit 0
fi

if rg -q 'error: An internal error occurred \(WriteFailed\)' "${log_file}" && rg -q '0 fail' "${log_file}"; then
  echo "::warning::Bun coverage ended with WriteFailed after tests passed; continuing to verify coverage output"
  exit 0
fi

exit "${status}"
