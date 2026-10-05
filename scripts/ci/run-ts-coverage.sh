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

shard_logs=(coverage/shards/shard-*.log)
if [[ -f "${shard_logs[0]:-}" ]]; then
  tolerated=1
  saw_write_failed=0
  coverage_lcov_files=()
  coverage_junit_files=()
  for shard_log in "${shard_logs[@]}"; do
    if grep -Eq 'error: An internal error occurred \(WriteFailed\)' "${shard_log}"; then
      saw_write_failed=1
    fi
    if ! grep -Eq '(^|[^0-9])0 fail' "${shard_log}" || grep -Eq '(^|[^0-9])[1-9][0-9]* fail' "${shard_log}"; then
      tolerated=0
      break
    fi
  done
  if [[ "${tolerated}" -eq 1 && "${saw_write_failed}" -eq 1 ]]; then
    for shard_log in "${shard_logs[@]}"; do
      shard_dir="${shard_log%.log}"
      bash scripts/ci/verify-ts-coverage-output.sh "${shard_dir}"
      coverage_lcov_files+=("${shard_dir}/lcov.info")
      shard_number="${shard_dir##*-}"
      shard_junit="coverage/shards/shard-${shard_number}.xml"
      if [[ -f "${shard_junit}" ]]; then
        coverage_junit_files+=("${shard_junit}")
      fi
    done
    echo "::warning::Bun coverage ended with WriteFailed after tests passed; continuing to verify coverage output"
    tail -n 80 "${log_file}"
    if [[ "${#coverage_lcov_files[@]}" -eq 1 ]]; then
      cp "${coverage_lcov_files[0]}" coverage/lcov.info
    elif [[ "${#coverage_lcov_files[@]}" -gt 1 ]]; then
      bun scripts/lib/merge-lcov.ts coverage/lcov.info "${coverage_lcov_files[@]+"${coverage_lcov_files[@]}"}"
    fi
    if [[ "${#coverage_junit_files[@]}" -eq 1 ]]; then
      cp "${coverage_junit_files[0]}" coverage/junit.xml
    elif [[ "${#coverage_junit_files[@]}" -gt 1 ]]; then
      bun scripts/lib/merge-junit-reports.ts coverage/junit.xml "${coverage_junit_files[@]+"${coverage_junit_files[@]}"}"
    fi
    exit 0
  fi
elif grep -Eq 'error: An internal error occurred \(WriteFailed\)' "${log_file}" && grep -Eq '(^|[^0-9])0 fail' "${log_file}"; then
  echo "::warning::Bun coverage ended with WriteFailed after tests passed; continuing to verify coverage output"
  tail -n 80 "${log_file}"
  bash scripts/ci/verify-ts-coverage-output.sh coverage
  exit 0
fi

echo "::group::Failing tests"
bash "$(dirname "${BASH_SOURCE[0]}")/summarize-bun-failures.sh" "${log_file}" || true
echo "::endgroup::"
tail -n 200 "${log_file}"
if [[ "${status}" -eq 124 ]]; then
  { grep -h 'wall-clock budget' "${log_file}" || true; } | sed 's/^/::error::coverage: /' >&2
fi
exit "${status}"
