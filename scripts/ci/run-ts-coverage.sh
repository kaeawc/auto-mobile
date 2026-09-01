#!/usr/bin/env bash
#
# Run TypeScript tests with Bun coverage. Coverage output is intentionally
# written to a log file instead of streamed live because Bun can hit WriteFailed
# when GitHub Actions receives the large coverage table.
#
# Usage:
#   scripts/ci/run-ts-coverage.sh [log-file]

set -euo pipefail

log_file="${1:-ci-logs/ts-coverage.log}"
mkdir -p "$(dirname "${log_file}")"
rm -rf coverage

set +e
bash scripts/test-ts.sh coverage > "${log_file}" 2>&1
status=$?
set -e

if [[ "${status}" -eq 0 ]]; then
  tail -n 80 "${log_file}"
  bash scripts/ci/verify-ts-coverage-output.sh coverage
  exit 0
fi

if rg -q 'error: An internal error occurred \(WriteFailed\)' "${log_file}" && rg -q '(^|[^0-9])0 fail' "${log_file}"; then
  echo "::warning::Bun coverage ended with WriteFailed after tests passed; continuing to verify coverage output"
  tail -n 80 "${log_file}"
  bash scripts/ci/verify-ts-coverage-output.sh coverage
  exit 0
fi

echo "::group::Failing tests"
rg -a '\(fail\)|^error:|^Ran [0-9]+ tests' "${log_file}" || true
echo "::endgroup::"
tail -n 200 "${log_file}"
exit "${status}"
